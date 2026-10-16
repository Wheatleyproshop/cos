import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import { messages, type EmailAutomationKey } from '@/db/schema';
import { recordEvent } from '../audit';
import { dispatchMessages } from '../email/outbox';
import { renderSample } from '../email/preview';
import { fromHeader } from '../email/sender';
import { TEMPLATE_KEYS } from '../email/templates';
import { appUrl } from '../tokens';
import { requireRole, ServiceError, type Ctx } from './common';

const schema = z.object({
  template: z.enum(TEMPLATE_KEYS as [EmailAutomationKey, ...EmailAutomationKey[]]),
  to: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

/** Sends one template with sample details to a chosen address, through the real email provider. */
export async function sendTestEmail(ctx: Ctx, raw: unknown): Promise<string> {
  requireRole(ctx, 'admin', 'send test emails');
  const r = schema.safeParse(raw);
  if (!r.success) throw new ServiceError('Enter a valid email address.', { to: 'Enter a valid email address' });
  const { template, to } = r.data;
  const rendered = await renderSample(ctx.org, template, appUrl('/'));

  const id = await withTenant(ctx.org.id, async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        organisationId: ctx.org.id, templateType: template, recipient: to, subject: `[Test] ${rendered.subject}`,
        bodyHtml: rendered.html, bodyText: rendered.text, status: 'queued', sentByUserId: ctx.userId,
      })
      .returning({ id: messages.id });
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'email_queued', entityType: 'message', entityId: m.id,
      metadata: { template, recipient: to, messageId: m.id, test: true },
    });
    return m.id;
  });

  await dispatchMessages(ctx.org, [id]);
  const [sent] = await withTenant(ctx.org.id, (tx) => tx.select().from(messages).where(eq(messages.id, id)));
  if (sent.status === 'failed') throw new ServiceError(`The email provider rejected it: ${sent.error ?? 'unknown error'}`);
  return sent.simulated
    ? `Test rendered but not sent: no email provider is configured on this server.`
    : `Test sent to ${to} from ${fromHeader(ctx.org)}. Check the inbox (and junk folder) in a minute.`;
}
