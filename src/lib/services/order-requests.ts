import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { auditEvents, customers, organisations, quotes, type Organisation, type Quote } from '@/db/schema';
import { recordEvent } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import { resendApiKey } from '../email/resend-key';
import { fromHeader } from '../email/sender';
import { HANDS } from '../order-details';
import { appUrl } from '../tokens';
import { ServiceError } from './common';
import { customerDesignCtx } from './online-designs';
import { createQuote } from './quotes';

/**
 * Special order requests from the shop's website: a customer asks for something the shop doesn't
 * have in stock, and it arrives in COS as a draft quote (price to be filled in) for staff to price,
 * check availability and send for approval.
 */

export const REQUEST_LIMITS = { perIpPerHour: 5, perShopPerDay: 40 };
export const NEEDED_BY = ['No rush', 'Within 2 weeks', 'Within a month', 'For a specific date (see notes)'] as const;

export type RequestSpec = { kind: 'cos-request'; version: 1; submittedOnline: true; budget: string; neededBy: string };
export const asRequestSpec = (json: unknown): RequestSpec | null => ((json as RequestSpec | null)?.kind === 'cos-request' ? (json as RequestSpec) : null);

const t = (n: number) => z.string().trim().max(n, `Keep this under ${n} characters`).default('');
const requestSchema = z.object({
  customerName: z.string().trim().min(2, 'Please enter your name').max(120),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  phone: t(40),
  brand: z.string().trim().min(1, 'Which brand?').max(80),
  category: t(40),
  product: z.string().trim().min(2, 'What would you like?').max(160),
  colour: t(60),
  size: t(40),
  hand: z.enum(HANDS).default(''),
  quantity: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(99, 'Up to 99').default(1),
  details: t(2000),
  budget: t(40),
  neededBy: z.enum(NEEDED_BY).default('No rush'),
});

export async function findRequestShop(slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, slug)).limit(1);
  return org?.orderRequestLink ? org : null;
}

async function checkLimits(orgId: string, ip: string | null) {
  const [recent] = await withTenant(orgId, (tx) =>
    tx
      .select({
        shop: sql<number>`count(*)::int`,
        ip: sql<number>`count(*) filter (where ${auditEvents.metadataJson}->>'ip' = ${ip ?? ''} and ${auditEvents.createdAt} > now() - interval '1 hour')::int`,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, 'order_request_submitted'), gt(auditEvents.createdAt, sql`now() - interval '1 day'`))),
  );
  if ((ip && recent.ip >= REQUEST_LIMITS.perIpPerHour) || recent.shop >= REQUEST_LIMITS.perShopPerDay) {
    throw new ServiceError('We’ve had a lot of requests in a short time. Please try again later or contact the shop.');
  }
}

export async function submitOrderRequest(slug: string, raw: Record<string, unknown>, meta: { ip: string | null }) {
  const org = await findRequestShop(slug);
  if (!org) throw new ServiceError('Requests can’t be sent online at the moment. Please contact the shop.');
  const res = requestSchema.safeParse(raw);
  if (!res.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of res.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    throw new ServiceError('Please check the highlighted fields.', fieldErrors);
  }
  const v = res.data;
  await checkLimits(org.id, meta.ip);
  const ctx = await customerDesignCtx(org, v.customerName);
  const spec: RequestSpec = { kind: 'cos-request', version: 1, submittedOnline: true, budget: v.budget, neededBy: v.neededBy };
  const quote = await createQuote(
    ctx,
    {
      customerName: v.customerName, email: v.email, phone: v.phone, customerId: '',
      brand: v.brand, category: v.category, product: v.product, sku: '',
      colour: v.colour, size: v.size, hand: v.hand, quantity: String(v.quantity), variant: '',
      specificationText: v.details,
      totalGrossPence: '0', depositRequiredPence: '', estimatedLeadTime: '', validUntil: '',
      internalNotes: [
        'Special order request from the website — price and availability to check, then send the quote.',
        v.budget ? `Budget: ${v.budget}` : '',
        `Needed: ${v.neededBy}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    { specificationJson: spec },
  );
  const messageId = await withTenant(org.id, async (tx) => {
    await recordEvent(tx, {
      organisationId: org.id, actor: ctx.actor, eventType: 'order_request_submitted', entityType: 'quote', quoteId: quote.id, customerId: quote.customerId,
      newValue: { product: `${quote.brand} ${quote.product}`, neededBy: v.neededBy, budget: v.budget || undefined }, metadata: { ip: meta.ip ?? '' },
    });
    return enqueueEmail(tx, {
      org, template: 'order_request_received', recipient: v.email, customerId: quote.customerId, quoteId: quote.id, actor: ctx.actor,
      context: { customerName: v.customerName, reference: quote.quoteNumber, brand: quote.brand, product: quote.product, specification: quote.specificationText, totalPence: 0 },
    });
  });
  await dispatchMessages(org, [messageId]);
  await alertShop(org, quote, v).catch((e) => console.error('[COS request alert]', e));
  return quote;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function alertShop(org: Organisation, quote: Quote, v: z.infer<typeof requestSchema>) {
  if (!org.replyToEmail) return;
  const link = appUrl(`/quotes/${quote.quoteNumber}`);
  const subject = `Special order request from ${v.customerName}: ${quote.brand} ${quote.product} (${quote.quoteNumber})`;
  const lines = [
    `${v.customerName} has asked for a special order on your website.`,
    '',
    `${quote.brand} ${quote.product}`,
    quote.specificationText,
    '',
    `Needed: ${v.neededBy}${v.budget ? ` · Budget: ${v.budget}` : ''}`,
    `Contact: ${v.email}${v.phone ? ` · ${v.phone}` : ''}`,
    '',
    `Price it and send the quote: ${link}`,
  ];
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1d2a22;max-width:560px">
<p><b>${esc(v.customerName)}</b> has asked for a special order on your website.</p>
<p><b>${esc(`${quote.brand} ${quote.product}`)}</b></p>
<p style="white-space:pre-line;color:#4b5a51">${esc(quote.specificationText)}</p>
<p>Needed: ${esc(v.neededBy)}${v.budget ? ` · Budget: ${esc(v.budget)}` : ''}<br>Contact: ${esc(v.email)}${v.phone ? ` · ${esc(v.phone)}` : ''}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#193b2c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Price ${quote.quoteNumber}</a></p></div>`;
  const key = resendApiKey();
  if (!key) return console.log(`[COS email · simulated] request alert to=${org.replyToEmail} subject="${subject}"`);
  const res = await new Resend(key).emails.send({
    from: fromHeader(org), to: [org.replyToEmail], replyTo: v.email, subject, html, text: lines.join('\n'), tags: [{ name: 'cos_alert', value: 'order_request' }],
  });
  if (res.error) console.error('[COS request alert]', res.error.message);
}

/** Website requests still waiting for a price (draft quotes). */
export async function listOpenRequests(orgId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ quoteNumber: quotes.quoteNumber, brand: quotes.brand, product: quotes.product, createdAt: quotes.createdAt, customer: customers.name, spec: quotes.specificationJson })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(sql`${quotes.specificationJson}->>'kind' = 'cos-request'`, eq(quotes.status, 'draft'), isNull(quotes.archivedAt)))
      .orderBy(desc(quotes.createdAt))
      .limit(30),
  );
}
