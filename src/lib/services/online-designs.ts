import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { withTenant } from '@/db';
import { auditEvents, customers, orders, quotes, users, type Organisation, type Quote } from '@/db/schema';
import { recordEvent } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import { resendApiKey } from '../email/resend-key';
import { fromHeader } from '../email/sender';
import { money } from '../format';
import { appUrl } from '../tokens';
import { ServiceError, type Ctx } from './common';
import { proofPathFor } from './quotes';

/**
 * Shared plumbing for the public "design your own" pages (golf balls, clothing cresting):
 * abuse limits, who the draft quote belongs to, and what happens once a design is in.
 */

export type DesignKind = 'ball' | 'cresting';
const EVENT = { ball: 'ball_design_submitted', cresting: 'crest_design_submitted' } as const;
const WORDS = {
  ball: { thing: 'personalised golf balls', short: 'golf ball', next: 'put it into print' },
  cresting: { thing: 'crested clothing', short: 'cresting', next: 'put it into production' },
};

/** Across both design pages: per person per hour, per shop per day. */
export const DESIGN_LIMITS = { perIpPerHour: 5, perShopPerDay: 60 };

/** Throws if this person or the shop has had too many online designs recently. */
export async function checkDesignLimits(orgId: string, ip: string | null) {
  const [recent] = await withTenant(orgId, (tx) =>
    tx
      .select({
        shop: sql<number>`count(*)::int`,
        ip: sql<number>`count(*) filter (where ${auditEvents.metadataJson}->>'ip' = ${ip ?? ''} and ${auditEvents.createdAt} > now() - interval '1 hour')::int`,
      })
      .from(auditEvents)
      .where(and(inArray(auditEvents.eventType, Object.values(EVENT)), gt(auditEvents.createdAt, sql`now() - interval '1 day'`))),
  );
  if ((ip && recent.ip >= DESIGN_LIMITS.perIpPerHour) || recent.shop >= DESIGN_LIMITS.perShopPerDay) {
    throw new ServiceError('We’ve had a lot of designs in a short time. Please try again later or contact the shop.');
  }
}

/** Quotes belong to a staff member: online designs are assigned to the shop owner until someone picks them up. */
export async function customerDesignCtx(org: Organisation, customerName: string): Promise<Ctx> {
  const [owner] = await withTenant(org.id, (tx) =>
    tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.active, true))).orderBy(asc(users.createdAt)).limit(1),
  );
  if (!owner) throw new ServiceError('This design page isn’t available at the moment. Please contact the shop.');
  const name = customerName.trim().slice(0, 120);
  return { org, actor: { type: 'customer', name: name || 'Customer' }, userId: owner.id, role: null };
}

/** Records the submission, emails the customer "we've received it" and alerts the shop. */
export async function designSubmitted(kind: DesignKind, ctx: Ctx, quote: Quote, ip: string | null) {
  const { org } = ctx;
  const messageId = await withTenant(org.id, async (tx) => {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, quote.customerId)).limit(1);
    await recordEvent(tx, {
      organisationId: org.id, actor: ctx.actor, eventType: EVENT[kind], entityType: 'quote', quoteId: quote.id,
      customerId: quote.customerId, newValue: { product: `${quote.brand} ${quote.product}`, totalPence: quote.totalGrossPence },
      metadata: { ip: ip ?? '' },
    });
    return enqueueEmail(tx, {
      org, template: 'ball_design_received', recipient: customer.email, customerId: customer.id, quoteId: quote.id, actor: ctx.actor,
      context: {
        customerName: customer.name, reference: quote.quoteNumber, brand: quote.brand, product: quote.product,
        specification: quote.specificationText, totalPence: quote.totalGrossPence, previewImageUrl: appUrl(proofPathFor(quote.id)),
        journey: kind === 'cresting' ? 'cresting' : 'print',
      },
    });
  });
  await dispatchMessages(org, [messageId]);
  const name = ctx.actor.type === 'customer' ? ctx.actor.name : 'A customer';
  await alertShop(kind, org, quote, name).catch((e) => console.error('[COS design alert]', e));
}

const escHtml = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Short internal heads-up to the shop's own address. */
async function alertShop(kind: DesignKind, org: Organisation, quote: Quote, name: string) {
  if (!org.replyToEmail) return;
  const w = WORDS[kind];
  const link = appUrl(`/quotes/${quote.quoteNumber}`);
  const subject = `New ${w.short} design from ${name} (${quote.quoteNumber})`;
  const priceNote = kind === 'cresting' ? 'Cresting price (garment to be added)' : 'List price';
  const text = `${name} has designed ${w.thing} online.\n\n${quote.specificationText}\n\n${priceNote}: ${money(quote.totalGrossPence)}\n\nReview it: ${link}`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1d2a22;max-width:560px">
<p><b>${escHtml(name)}</b> has designed ${w.thing} online.</p>
<p><img src="${escHtml(appUrl(proofPathFor(quote.id)))}" width="320" alt="Design preview" style="max-width:100%;border-radius:12px;background:#eef0f4"></p>
<p style="white-space:pre-line;color:#4b5a51">${escHtml(quote.specificationText)}</p>
<p>${priceNote}: <b>${money(quote.totalGrossPence)}</b></p>
<p><a href="${escHtml(link)}" style="display:inline-block;background:#193b2c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Review ${quote.quoteNumber}</a></p>
<p style="color:#7a857e;font-size:13px">Approve it in store to ${w.next}, or edit it and email a proof back.</p></div>`;
  const key = resendApiKey();
  if (!key) return console.log(`[COS email · simulated] ${w.short} design alert to=${org.replyToEmail} subject="${subject}"`);
  const res = await new Resend(key).emails.send({ from: fromHeader(org), to: [org.replyToEmail], subject, html, text, tags: [{ name: 'cos_alert', value: `${kind}_design` }] });
  if (res.error) console.error('[COS design alert]', res.error.message);
}

/** Online designs still waiting for the shop to act on them. */
export async function listSubmittedDesigns(orgId: string, kind: DesignKind = 'ball') {
  return withTenant(orgId, (tx) =>
    tx
      .select({ quoteNumber: quotes.quoteNumber, product: quotes.product, brand: quotes.brand, totalGrossPence: quotes.totalGrossPence, createdAt: quotes.createdAt, customer: customers.name })
      .from(auditEvents)
      .innerJoin(quotes, eq(quotes.id, auditEvents.quoteId))
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(eq(auditEvents.eventType, EVENT[kind]), eq(quotes.status, 'draft'), isNull(quotes.archivedAt)))
      .orderBy(desc(quotes.createdAt))
      .limit(20),
  );
}

/**
 * Everything in progress for an in-house service (ball printing / cresting): open proofs (quotes,
 * including designs sent in online) and approved jobs not yet collected, with what's still owed.
 */
export async function inHouseWork(orgId: string, kind: DesignKind) {
  const specKind = kind === 'cresting' ? 'cos-cresting' : 'cos-ball-print';
  return withTenant(orgId, async (tx) => {
    const proofs = await tx
      .select({ q: quotes, customer: customers.name, email: customers.email })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(sql`${quotes.specificationJson}->>'kind' = ${specKind}`, inArray(quotes.status, ['draft', 'sent']), isNull(quotes.archivedAt)))
      .orderBy(desc(quotes.createdAt))
      .limit(50);
    const jobs = await tx
      .select({
        o: orders,
        customer: customers.name,
        paid: sql<number>`(select coalesce(sum(case when p.kind = 'refund' then -p.amount_pence when p.kind = 'void' then 0 else p.amount_pence end), 0)::int
          from payments p where p.order_id = ${orders.id} and not exists (select 1 from payments v where v.voids_payment_id = p.id))`,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(sql`${orders.specificationJson}->>'kind' = ${specKind}`, sql`${orders.status} <> 'collected'`, isNull(orders.archivedAt)))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return {
      proofs: proofs.map((r) => ({ ...r, online: Boolean((r.q.specificationJson as { submittedOnline?: boolean } | null)?.submittedOnline) })),
      jobs: jobs.map((r) => ({ ...r, balance: r.o.totalGrossPence - Number(r.paid ?? 0) })),
    };
  });
}
