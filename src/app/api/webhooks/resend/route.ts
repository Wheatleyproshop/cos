import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { messages, type MessageStatus } from '@/db/schema';
import { recordEvent, SYSTEM } from '@/lib/audit';
import { safeEqual } from '@/lib/tokens';

/** Verifies Resend's Svix signature: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)). */
function verify(req: Request, body: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = req.headers.get('svix-id');
  const ts = req.headers.get('svix-timestamp');
  const sigs = req.headers.get('svix-signature');
  if (!secret || !id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return sigs.split(' ').some((s) => safeEqual(s.split(',')[1] ?? '', expected));
}

const MAP: Record<string, { status: MessageStatus; event: 'email_delivered' | 'email_failed' } | undefined> = {
  'email.delivered': { status: 'delivered', event: 'email_delivered' },
  'email.bounced': { status: 'bounced', event: 'email_failed' },
  'email.failed': { status: 'failed', event: 'email_failed' },
  'email.complained': { status: 'delivered', event: 'email_failed' },
};

export async function POST(req: Request) {
  const body = await req.text();
  if (!verify(req, body)) return new Response('Invalid signature', { status: 401 });
  const payload = JSON.parse(body) as { type: string; data?: { email_id?: string; bounce?: { message?: string } } };
  const change = MAP[payload.type];
  const providerId = payload.data?.email_id;
  if (!change || !providerId) return Response.json({ ok: true, ignored: payload.type });

  // Resolve the tenant from the provider id, then write inside that tenant's scope.
  const [hit] = await systemDb()
    .select({ id: messages.id, orgId: messages.organisationId })
    .from(messages)
    .where(eq(messages.providerMessageId, providerId))
    .limit(1);
  if (!hit) return Response.json({ ok: true, unknown: true });

  await withTenant(hit.orgId, async (tx) => {
    const [m] = await tx.select().from(messages).where(eq(messages.id, hit.id)).limit(1);
    if (!m || m.status === change.status) return;
    const now = new Date();
    const error = payload.type === 'email.complained' ? 'Recipient marked as spam' : payload.data?.bounce?.message ?? null;
    await tx
      .update(messages)
      .set(change.status === 'delivered' ? { status: 'delivered', deliveredAt: now } : { status: change.status, failedAt: now, error })
      .where(eq(messages.id, m.id));
    await recordEvent(tx, {
      organisationId: hit.orgId, actor: SYSTEM, eventType: change.event, entityType: m.orderId ? 'order' : 'quote',
      orderId: m.orderId, quoteId: m.quoteId, customerId: m.customerId,
      metadata: { template: m.templateType, messageId: m.id, providerMessageId: providerId, providerEvent: payload.type, error },
    });
  });
  return Response.json({ ok: true });
}
