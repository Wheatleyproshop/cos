import { and, eq } from 'drizzle-orm';
import { systemDb, withTenant, type DB } from '@/db';
import { customers, organisations, orders, quotes, type Customer, type Organisation, type Quote } from '@/db/schema';
import { recordEvent, type Actor } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import { asBallPrintSpec } from '../ball-print';
import { fitSpec } from '../fit-spec';
import { todayInTz } from '../format';
import { composeSpec } from '../order-details';
import { journeyFor } from '../status';
import { appUrl, hashToken, newToken, signValue } from '../tokens';
import { parse, quoteCreateSchema, quoteEditSchema } from '../validation';
import { findOrCreateCustomer, issueTrackingLink, nextNumber, ServiceError, type Ctx } from './common';
import { orderEmailContext } from './orders';

async function loadQuote(tx: DB, orgId: string, quoteId: string) {
  const [row] = await tx
    .select({ quote: quotes, customer: customers })
    .from(quotes)
    .innerJoin(customers, eq(customers.id, quotes.customerId))
    .where(and(eq(quotes.id, quoteId), eq(quotes.organisationId, orgId)))
    .for('update', { of: quotes })
    .limit(1);
  if (!row) throw new ServiceError('Quote not found.');
  return row;
}

/** Public URL of a ball-printing proof image. Signed per quote, so it keeps working after approval. */
export function proofPathFor(quoteId: string) {
  return `/api/public/ball-proof/${quoteId}/${signValue(`ball-proof:${quoteId}`)}`;
}

function quoteEmailContext(q: Quote, c: Customer, url: string) {
  const isPrint = asBallPrintSpec(q.specificationJson);
  return {
    previewImageUrl: isPrint ? appUrl(proofPathFor(q.id)) : undefined,
    fit: fitSpec(q.specificationJson),
    customerName: c.name,
    reference: q.quoteNumber,
    brand: q.brand,
    product: q.product,
    specification: q.specificationText,
    totalPence: q.totalGrossPence,
    depositRequiredPence: q.depositRequiredPence,
    leadTime: q.estimatedLeadTime,
    validUntil: q.validUntil,
    actionUrl: url,
  };
}

export function isExpired(q: Pick<Quote, 'validUntil' | 'status'>, tz: string) {
  return q.status === 'expired' || Boolean(q.validUntil && q.validUntil < todayInTz(tz));
}

/** Rotates the approval token (old links stop working) and marks the quote sent. */
async function issueApprovalLink(tx: DB, ctx: Ctx, quote: Quote): Promise<string> {
  const token = newToken();
  const now = new Date();
  await tx
    .update(quotes)
    .set({ tokenHash: hashToken(token), status: 'sent', sentAt: quote.sentAt ?? now, updatedAt: now })
    .where(eq(quotes.id, quote.id));
  return appUrl(`/q/${token}`);
}

export type CreateQuoteOptions = {
  send?: boolean;
  /** Structured build from COS Configure / Custom Fitting. */
  specificationJson?: unknown;
  /** Runs in the same transaction after the quote row exists (e.g. configuration items). */
  afterInsert?: (tx: DB, quote: Quote) => Promise<void>;
};

export async function createQuote(ctx: Ctx, raw: unknown, opts: CreateQuoteOptions = {}) {
  if (!ctx.userId) throw new ServiceError('Quotes must be created by a signed-in staff member.');
  const input = parse(quoteCreateSchema, raw);
  const { quote, messageId } = await withTenant(ctx.org.id, async (tx) => {
    const customer = await findOrCreateCustomer(tx, ctx, { name: input.customerName, email: input.email, phone: input.phone, customerId: input.customerId });
    const quoteNumber = await nextNumber(tx, ctx.org.id, 'quote');
    const [quote] = await tx
      .insert(quotes)
      .values({
        organisationId: ctx.org.id,
        quoteNumber,
        customerId: customer.id,
        brand: input.brand,
        category: input.category,
        product: input.product,
        sku: input.sku,
        specificationText: composeSpec({ ...input, notes: input.specificationText }),
        totalGrossPence: input.totalGrossPence,
        depositRequiredPence: input.depositRequiredPence,
        estimatedLeadTime: input.estimatedLeadTime,
        validUntil: input.validUntil,
        internalNotes: input.internalNotes,
        specificationJson: opts.specificationJson ?? null,
        createdByUserId: ctx.userId!,
      })
      .returning();
    if (opts.afterInsert) await opts.afterInsert(tx, quote);
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'quote_created',
      entityType: 'quote',
      quoteId: quote.id,
      customerId: customer.id,
      newValue: snapshot(quote),
    });
    const messageId = opts.send ? await sendInTx(tx, ctx, quote, customer) : null;
    return { quote, messageId };
  });
  await dispatchMessages(ctx.org, [messageId]);
  return quote;
}

async function sendInTx(tx: DB, ctx: Ctx, quote: Quote, customer: Customer) {
  const url = await issueApprovalLink(tx, ctx, quote);
  await recordEvent(tx, {
    organisationId: ctx.org.id,
    actor: ctx.actor,
    eventType: 'quote_sent',
    entityType: 'quote',
    quoteId: quote.id,
    customerId: customer.id,
  });
  return enqueueEmail(tx, {
    org: ctx.org,
    template: 'quote_approval',
    recipient: customer.email,
    customerId: customer.id,
    quoteId: quote.id,
    context: quoteEmailContext(quote, customer, url),
    actor: ctx.actor,
  });
}

function assertOpen(q: Quote) {
  if (q.archivedAt || !['draft', 'sent'].includes(q.status)) {
    throw new ServiceError(`This quote is ${q.status} and can no longer be changed.`);
  }
}

export async function sendQuote(ctx: Ctx, quoteId: string) {
  const messageId = await withTenant(ctx.org.id, async (tx) => {
    const { quote, customer } = await loadQuote(tx, ctx.org.id, quoteId);
    assertOpen(quote);
    return sendInTx(tx, ctx, quote, customer);
  });
  await dispatchMessages(ctx.org, [messageId]);
}

/** Generates a link for staff to share manually (WhatsApp/SMS). Revokes previous links. */
export async function createApprovalLink(ctx: Ctx, quoteId: string): Promise<string> {
  return withTenant(ctx.org.id, async (tx) => {
    const { quote, customer } = await loadQuote(tx, ctx.org.id, quoteId);
    assertOpen(quote);
    const url = await issueApprovalLink(tx, ctx, quote);
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'quote_link_created',
      entityType: 'quote',
      quoteId,
      customerId: customer.id,
    });
    return url;
  });
}

export async function editQuote(ctx: Ctx, quoteId: string, raw: unknown) {
  const input = parse(quoteEditSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const { quote } = await loadQuote(tx, ctx.org.id, quoteId);
    assertOpen(quote);
    const keys = [
      'brand', 'category', 'product', 'sku', 'specificationText', 'totalGrossPence', 'depositRequiredPence',
      'estimatedLeadTime', 'validUntil', 'internalNotes',
    ] as const;
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, unknown> = {};
    for (const k of keys) {
      if (input[k] !== quote[k]) {
        oldV[k] = quote[k];
        newV[k] = input[k];
      }
    }
    if (!Object.keys(newV).length) return;
    await tx.update(quotes).set({ ...newV, updatedAt: new Date() }).where(eq(quotes.id, quoteId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'quote_updated',
      entityType: 'quote',
      quoteId,
      customerId: quote.customerId,
      oldValue: oldV,
      newValue: newV,
    });
  });
}

export async function closeQuote(ctx: Ctx, quoteId: string, outcome: 'declined' | 'cancelled') {
  await withTenant(ctx.org.id, async (tx) => {
    const { quote } = await loadQuote(tx, ctx.org.id, quoteId);
    assertOpen(quote);
    await tx.update(quotes).set({ status: outcome, tokenHash: null, updatedAt: new Date() }).where(eq(quotes.id, quoteId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: outcome === 'declined' ? 'quote_declined' : 'quote_cancelled',
      entityType: 'quote',
      quoteId,
      customerId: quote.customerId,
      oldValue: { status: quote.status },
      newValue: { status: outcome },
    });
  });
}

function snapshot(q: Quote) {
  return {
    quoteNumber: q.quoteNumber,
    brand: q.brand,
    product: q.product,
    sku: q.sku,
    specificationText: q.specificationText,
    totalGrossPence: q.totalGrossPence,
    depositRequiredPence: q.depositRequiredPence,
    estimatedLeadTime: q.estimatedLeadTime,
    validUntil: q.validUntil,
  };
}

/**
 * Accepts a quote and converts it into an order without re-keying anything.
 * The acceptance event stores an exact snapshot of what the customer approved.
 */
async function acceptAndConvert(
  tx: DB,
  ctx: Ctx,
  quote: Quote,
  customer: Customer,
  acceptedName: string,
  meta: Record<string, unknown>,
) {
  assertOpen(quote);
  if (isExpired(quote, ctx.org.timezone)) throw new ServiceError('This quote has expired.');
  const now = new Date();
  const print = journeyFor(quote.specificationJson) === 'print';
  const orderNumber = await nextNumber(tx, ctx.org.id, 'order');
  const [order] = await tx
    .insert(orders)
    .values({
      organisationId: ctx.org.id,
      orderNumber,
      customerId: customer.id,
      quoteId: quote.id,
      // Printed balls come from stock and go straight into print; everything else still has to be placed with the supplier.
      status: print ? 'ordered' : 'place_order',
      brand: quote.brand,
      category: quote.category,
      product: quote.product,
      sku: quote.sku,
      supplier: quote.brand,
      specificationText: quote.specificationText,
      specificationJson: quote.specificationJson,
      totalGrossPence: quote.totalGrossPence,
      internalNotes: quote.internalNotes,
      // The staff member who took the customer's request owns the order.
      takenByUserId: quote.createdByUserId,
    })
    .returning();

  await tx
    .update(quotes)
    .set({ status: 'accepted', acceptedAt: now, acceptedName, convertedOrderId: order.id, tokenHash: null, updatedAt: now })
    .where(eq(quotes.id, quote.id));

  const base = { organisationId: ctx.org.id, actor: ctx.actor, customerId: customer.id };
  await recordEvent(tx, {
    ...base,
    eventType: 'quote_accepted',
    entityType: 'quote',
    quoteId: quote.id,
    newValue: { ...snapshot(quote), acceptedName, acceptedAt: now.toISOString() },
    metadata: meta,
  });
  await recordEvent(tx, {
    ...base,
    eventType: 'order_created',
    entityType: 'order',
    orderId: order.id,
    quoteId: quote.id,
    newValue: { orderNumber, status: order.status, ...snapshot(quote), takenByUserId: order.takenByUserId },
    metadata: { fromQuote: quote.quoteNumber },
  });
  await recordEvent(tx, {
    ...base,
    eventType: 'quote_converted',
    entityType: 'quote',
    quoteId: quote.id,
    orderId: order.id,
    newValue: { orderId: order.id, orderNumber },
  });

  const link = await issueTrackingLink(tx, ctx.org.id, order.id);
  // Supplier orders: the customer hears from us once the order is actually placed (with its ETA).
  if (!print) return { order, messageId: null, trackingUrl: link };
  const messageId = await enqueueEmail(tx, {
    org: ctx.org,
    template: 'order_confirmation',
    recipient: customer.email,
    customerId: customer.id,
    orderId: order.id,
    context: orderEmailContext(order, customer, { paid: 0, credit: 0 }, link),
    actor: ctx.actor,
  });
  return { order, messageId, trackingUrl: link };
}

/** Staff record an approval given in person / by phone. */
export async function acceptQuoteInStore(ctx: Ctx, quoteId: string, acceptedName: string) {
  const name = acceptedName.trim().slice(0, 120);
  if (!name) throw new ServiceError('Enter the name of the person who approved the quote.', { acceptedName: 'Required' });
  const { order, messageId } = await withTenant(ctx.org.id, async (tx) => {
    const { quote, customer } = await loadQuote(tx, ctx.org.id, quoteId);
    return acceptAndConvert(tx, ctx, quote, customer, name, { recordedByStaff: true });
  });
  await dispatchMessages(ctx.org, [messageId]);
  return order;
}

/* ───────────────────────── Public (tokenised) access ───────────────────────── */

export type PublicQuote = { org: Organisation; quote: Quote; customer: Customer };

/** Resolves an approval token. Uses the system connection only to find the tenant. */
export async function findQuoteByToken(token: string): Promise<PublicQuote | null> {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const [hit] = await systemDb()
    .select({ orgId: quotes.organisationId, quoteId: quotes.id })
    .from(quotes)
    .where(eq(quotes.tokenHash, hashToken(token)))
    .limit(1);
  if (!hit) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.id, hit.orgId)).limit(1);
  return withTenant(hit.orgId, async (tx) => {
    const [row] = await tx
      .select({ quote: quotes, customer: customers })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(eq(quotes.id, hit.quoteId))
      .limit(1);
    return row ? { org, ...row } : null;
  });
}

export async function acceptQuoteByToken(token: string, acceptedName: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const name = acceptedName.trim().slice(0, 120);
  if (!name) throw new ServiceError('Please type your full name to approve.', { acceptedName: 'Required' });
  const found = await findQuoteByToken(token);
  if (!found) throw new ServiceError('This approval link is no longer valid. Please contact the shop.');
  const actor: Actor = { type: 'customer', name };
  const ctx: Ctx = { org: found.org, actor, userId: null, role: null };
  const { order, messageId, trackingUrl } = await withTenant(found.org.id, async (tx) => {
    const { quote, customer } = await loadQuote(tx, found.org.id, found.quote.id);
    return acceptAndConvert(tx, ctx, quote, customer, name, { channel: 'online', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
  });
  await dispatchMessages(found.org, [messageId]);
  return { order, trackingUrl };
}

