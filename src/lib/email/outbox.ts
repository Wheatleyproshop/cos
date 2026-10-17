import { eq, inArray } from 'drizzle-orm';
import { resendApiKey } from './resend-key';
import { Resend } from 'resend';
import { withTenant, type DB } from '@/db';
import { messages, type EmailAutomationKey, type Organisation } from '@/db/schema';
import { recordEvent, SYSTEM, type Actor } from '../audit';
import { fromHeader } from './sender';
import { renderEmail, type EmailContext, type StoreBranding } from './templates';

export function brandingFor(org: Organisation): StoreBranding {
  return {
    storeName: org.storeName,
    replyToEmail: org.replyToEmail,
    collectionLocation: org.collectionLocation,
    storePhone: org.storePhone,
    openingHours: org.openingHours,
    brandColor: org.brandColor,
    brandTheme: org.brandTheme,
  };
}

export type EnqueueInput = {
  org: Organisation;
  template: EmailAutomationKey;
  recipient: string;
  customerId: string;
  orderId?: string | null;
  quoteId?: string | null;
  workshopJobId?: string | null;
  context: Omit<EmailContext, 'store'>;
  actor: Actor;
  /** Staff chose not to notify the customer (manager+ only — enforced by caller). */
  suppressedBy?: string | null;
};

/**
 * Renders and records an outgoing email inside the caller's transaction.
 * Returns the message id to hand to `dispatchMessages` after commit, or null
 * if the email was suppressed (which is itself recorded on the ledger).
 */
export async function enqueueEmail(tx: DB, input: EnqueueInput): Promise<string | null> {
  const { org, template } = input;
  const rendered = renderEmail(template, { ...input.context, store: brandingFor(org) });
  const automationOn = org.emailAutomations?.[template] !== false;
  const reason = !automationOn
    ? 'automation turned off in store settings'
    : input.suppressedBy
      ? `customer notification skipped by ${input.suppressedBy}`
      : null;

  const [msg] = await tx
    .insert(messages)
    .values({
      organisationId: org.id,
      orderId: input.orderId ?? null,
      quoteId: input.quoteId ?? null,
      workshopJobId: input.workshopJobId ?? null,
      customerId: input.customerId,
      templateType: template,
      recipient: input.recipient,
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: reason ? 'suppressed' : 'queued',
      sentByUserId: input.actor.type === 'user' ? input.actor.userId : null,
    })
    .returning({ id: messages.id });

  await recordEvent(tx, {
    organisationId: org.id,
    actor: input.actor,
    eventType: reason ? 'email_suppressed' : 'email_queued',
    entityType: input.orderId ? 'order' : input.workshopJobId ? 'workshop_job' : 'quote',
    entityId: input.workshopJobId ?? undefined,
    orderId: input.orderId,
    quoteId: input.quoteId,
    customerId: input.customerId,
    metadata: { template, recipient: input.recipient, messageId: msg.id, ...(reason ? { reason } : {}) },
  });
  return reason ? null : msg.id;
}

let resendClient: Resend | null = null;
function resend(): Resend | null {
  if (!resendApiKey()) return null;
  resendClient ??= new Resend(resendApiKey());
  return resendClient;
}

/**
 * Sends queued messages. Called after the business transaction commits so a
 * provider outage never rolls back an order. Each outcome is written to the
 * message row and the ledger with the `system` actor.
 */
export async function dispatchMessages(org: Organisation, ids: (string | null | undefined)[]) {
  const pending = ids.filter((x): x is string => Boolean(x));
  if (!pending.length) return;
  const rows = await withTenant(org.id, (tx) => tx.select().from(messages).where(inArray(messages.id, pending)));
  const client = resend();

  for (const m of rows) {
    if (m.status !== 'queued') continue;
    let providerId: string | null = null;
    let error: string | null = null;
    const simulated = !client;
    try {
      if (client) {
        const res = await client.emails.send({
          from: fromHeader(org),
          to: [m.recipient],
          replyTo: org.replyToEmail,
          subject: m.subject,
          html: m.bodyHtml,
          text: m.bodyText,
          tags: [{ name: 'cos_message', value: m.id }],
        });
        if (res.error) error = res.error.message;
        else providerId = res.data?.id ?? null;
      } else {
        providerId = `simulated-${m.id}`;
        console.info(`[COS email · simulated] to=${m.recipient} subject="${m.subject}"`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    await withTenant(org.id, async (tx) => {
      const now = new Date();
      await tx
        .update(messages)
        .set(
          error
            ? { status: 'failed', error, failedAt: now }
            : { status: 'sent', providerMessageId: providerId, sentAt: now, simulated },
        )
        .where(eq(messages.id, m.id));
      await recordEvent(tx, {
        organisationId: org.id,
        actor: SYSTEM,
        eventType: error ? 'email_failed' : 'email_sent',
        entityType: m.orderId ? 'order' : m.quoteId ? 'quote' : 'message',
        entityId: m.orderId || m.quoteId ? undefined : m.id,
        orderId: m.orderId,
        quoteId: m.quoteId,
        customerId: m.customerId,
        metadata: { template: m.templateType, recipient: m.recipient, messageId: m.id, providerMessageId: providerId, simulated, error },
      });
    });
  }
}
