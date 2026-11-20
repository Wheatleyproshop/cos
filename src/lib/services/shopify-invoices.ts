import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { ballPromotions, customers, orders, organisations, quotes, shopifyInvoices, type BallPromotion, type Organisation, type Quote, type ShopifyInvoice } from '@/db/schema';
import { recordEvent, type Actor } from '../audit';
import { asBallPrintSpec, INK_COLOURS, PRINT_FONTS } from '../ball-print';
import { dispatchMessages } from '../email/outbox';
import { money } from '../format';
import {
  createDraftOrder, deleteDraftOrder, findOrCreateCustomer, findVariantsByHandle, invoiceMode, invoiceSetupProblems, sendDraftOrderInvoice, ShopifyInvoiceError, type InvoiceMode,
} from '../shopify-admin';
import { buildDraftOrder, COS_INVOICE_ATTR, deliveryFromOrder, KNOWN_PROMO_VARIANTS, type InvoiceDesign, type InvoicePlan, type OrderShipping } from '../shopify-invoice';
import { appUrl, signValue } from '../tokens';
import { paidPence, ServiceError, type Ctx } from './common';
import { insertPayment } from './orders';
import { acceptAndConvert, proofPathFor } from './quotes';

/**
 * Pay before print. Staff approve a customer's ball proof; COS creates a Shopify draft order and
 * Shopify emails the customer an invoice. When Shopify reports it paid (webhook), each design
 * becomes an order "Paid – ready to print", with the payment recorded against it.
 */

/** An unpaid invoice older than this is flagged in the staff lists. */
export const UNPAID_FLAG_DAYS = 3;

const OPEN = ['draft', 'sent'] as const;
export const logoPathFor = (quoteId: string) => `/api/public/ball-logo/${quoteId}/${signValue(`ball-logo:${quoteId}`)}`;

function personalisationText(q: Pick<Quote, 'specificationJson'>) {
  const s = asBallPrintSpec(q.specificationJson)!;
  if (s.artwork.type === 'logo') return `Logo: ${s.artwork.filename}`;
  const font = PRINT_FONTS.find((f) => f.key === (s.artwork as { font: string }).font)?.label ?? '';
  const ink = INK_COLOURS.find((c) => c.key === (s.artwork as { ink: string }).ink)?.label ?? '';
  return `Text: “${s.artwork.lines.join(' / ')}” (${font}, ${ink} ink)`;
}

/** The quote as a design line for the invoice, with the promotion's multi-buy if it has one. */
async function toDesigns(orgId: string, rows: Quote[], orderFor: Map<string, { orderNumber: string; owedPence: number }>): Promise<InvoiceDesign[]> {
  const promoIds = [...new Set(rows.map((q) => asBallPrintSpec(q.specificationJson)?.promo?.id).filter((x): x is string => Boolean(x)))];
  const promos = promoIds.length ? await withTenant(orgId, (tx) => tx.select().from(ballPromotions).where(inArray(ballPromotions.id, promoIds))) : [];
  return rows.map((q) => {
    const o = orderFor.get(q.id);
    return designFromQuote(o ? { ...q, totalGrossPence: o.owedPence } : q, promos, o?.orderNumber);
  });
}

/** One quote as an invoice design line (pure apart from building the signed image links). */
export function designFromQuote(
  q: Pick<Quote, 'id' | 'quoteNumber' | 'totalGrossPence' | 'specificationJson'>,
  promos: Pick<BallPromotion, 'id' | 'multiBuyDozens' | 'multiBuyPricePence'>[],
  orderNumber?: string,
): InvoiceDesign {
  const s = asBallPrintSpec(q.specificationJson)!;
  const p = s.promo ? promos.find((x) => x.id === s.promo!.id) : undefined;
  return {
    quoteId: q.id, quoteNumber: q.quoteNumber, ball: { brand: s.ball.brand, name: s.ball.name }, dozens: s.dozens, pricePerDozenPence: s.pricePerDozenPence,
    setupFeePence: s.setupFeePence, quoteTotalPence: q.totalGrossPence, personalisation: personalisationText(q),
    reference: orderNumber ?? q.quoteNumber,
    cosUrl: appUrl(orderNumber ? `/orders/${orderNumber}` : `/quotes/${q.quoteNumber}`),
    proofUrl: appUrl(proofPathFor(q.id)), logoUrl: s.artwork.type === 'logo' ? appUrl(logoPathFor(q.id)) : null,
    promo: s.promo
      ? { id: s.promo.id, title: s.promo.title, multiBuy: p?.multiBuyDozens && p.multiBuyPricePence ? { dozens: p.multiBuyDozens, pricePence: p.multiBuyPricePence } : null }
      : null,
  };
}

/** Whether a quote can go on a new invoice: an open ball design with no live invoice. */
async function liveInvoiceIds(orgId: string, ids: (string | null)[]) {
  const real = ids.filter((x): x is string => Boolean(x));
  if (!real.length) return new Set<string>();
  const rows = await withTenant(orgId, (tx) =>
    tx.select({ id: shopifyInvoices.id }).from(shopifyInvoices).where(and(inArray(shopifyInvoices.id, real), inArray(shopifyInvoices.status, ['awaiting_payment', 'paid']))),
  );
  return new Set(rows.map((r) => r.id));
}

/** This customer's other open ball designs that could go on the same invoice (e.g. a second ball for the multi-buy). */
export async function invoiceCompanions(orgId: string, quote: Pick<Quote, 'id' | 'customerId'>) {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.customerId, quote.customerId), inArray(quotes.status, [...OPEN]), isNull(quotes.archivedAt), sql`${quotes.specificationJson}->>'kind' = 'cos-ball-print'`)),
  );
  const live = await liveInvoiceIds(orgId, rows.map((r) => r.shopifyInvoiceId));
  return rows
    .filter((r) => r.id !== quote.id && !(r.shopifyInvoiceId && live.has(r.shopifyInvoiceId)))
    .map((r) => {
      const s = asBallPrintSpec(r.specificationJson)!;
      return { id: r.id, quoteNumber: r.quoteNumber, label: `${s.dozens} dozen ${s.ball.brand} ${s.ball.name}`, totalPence: r.totalGrossPence };
    });
}

export type InvoiceResult = { mode: InvoiceMode; invoice: ShopifyInvoice; plan: InvoicePlan };

/**
 * "Approve and send invoice". Builds the draft order for the quote (plus any companions ticked),
 * and in live mode creates it on Shopify and has Shopify email the invoice. In test mode the
 * payload is worked out and saved, but nothing leaves COS.
 */
export async function approveAndSendInvoice(
  ctx: Ctx,
  quoteId: string,
  companionIds: string[] = [],
  opts: { mode?: InvoiceMode } = {},
): Promise<InvoiceResult> {
  if (!ctx.userId) throw new ServiceError('Invoices must be sent by a signed-in staff member.');
  const mode = opts.mode ?? invoiceMode();
  const ids = [quoteId, ...companionIds.filter((x) => x !== quoteId)];

  const { rows, customer } = await withTenant(ctx.org.id, async (tx) => {
    const rows = await tx.select().from(quotes).where(inArray(quotes.id, ids));
    const main = rows.find((r) => r.id === quoteId);
    if (!main) throw new ServiceError('Quote not found.');
    const [customer] = await tx.select().from(customers).where(eq(customers.id, main.customerId)).limit(1);
    return { rows: ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is Quote => Boolean(r)), customer };
  });
  if (rows.length !== ids.length) throw new ServiceError('One of the designs couldn’t be found.');
  const live = await liveInvoiceIds(ctx.org.id, rows.map((r) => r.shopifyInvoiceId));
  for (const q of rows) {
    if (!asBallPrintSpec(q.specificationJson)) throw new ServiceError(`${q.quoteNumber} isn’t a ball design.`);
    if (q.customerId !== customer.id) throw new ServiceError(`${q.quoteNumber} is for a different customer.`);
    if (q.shopifyInvoiceId && live.has(q.shopifyInvoiceId)) throw new ServiceError(`${q.quoteNumber} already has a Shopify invoice.`);
    if (q.archivedAt) throw new ServiceError(`${q.quoteNumber} was deleted.`);
    const approvedUnpaid = q.status === 'accepted' && q.convertedOrderId;
    if (!(OPEN as readonly string[]).includes(q.status) && !approvedUnpaid) throw new ServiceError(`${q.quoteNumber} is already ${q.status}.`);
  }
  // Already approved and made into an order (e.g. approved in store before pay-before-print): invoice what's owed.
  const orderFor = new Map<string, { orderNumber: string; owedPence: number }>();
  for (const q of rows.filter((r) => r.status === 'accepted')) {
    const o = await withTenant(ctx.org.id, async (tx) => {
      const [row] = await tx.select().from(orders).where(eq(orders.id, q.convertedOrderId!)).limit(1);
      return row ? { row, paid: await paidPence(tx, row.id) } : null;
    });
    if (!o || o.row.removedAt) throw new ServiceError(`The order for ${q.quoteNumber} couldn’t be found.`);
    if (o.paid > 0) throw new ServiceError(`${o.row.orderNumber} already has ${money(o.paid)} paid, so it can’t go on a Shopify invoice. Take the rest in store.`);
    orderFor.set(q.id, { orderNumber: o.row.orderNumber, owedPence: o.row.totalGrossPence });
  }
  if (!customer.email) throw new ServiceError('Add the customer’s email address first: Shopify emails the invoice to it.');

  const designs = await toDesigns(ctx.org.id, rows, orderFor);
  const invoiceId = randomUUID();
  if (mode === 'live') {
    const problems = invoiceSetupProblems();
    if (problems.length) throw new ServiceError(`Shopify invoices aren’t set up yet: ${problems.join('; ')}.`);
  }
  const variants = mode === 'live' ? await findVariantsByHandle(designs.map((d) => d.ball.name)) : KNOWN_PROMO_VARIANTS;
  const shopifyCustomer = mode === 'live' ? await findOrCreateCustomer(customer) : null;
  const plan = buildDraftOrder({
    invoiceId, customer: { name: customer.name, email: customer.email, phone: customer.phone }, designs, variants, shopifyCustomerId: shopifyCustomer?.id ?? null,
  });
  if (mode === 'dry_run') plan.warnings.push(`Shopify customer: found by ${customer.email}, or created as ${customer.name} with that email${customer.phone ? ' and phone' : ''}.`);
  const base = {
    id: invoiceId, organisationId: ctx.org.id, customerId: customer.id, quoteIds: ids, totalPence: plan.totalPence, cosTotalPence: plan.cosTotalPence,
    payload: plan.input, warnings: plan.warnings, createdByUserId: ctx.userId,
  };

  if (mode === 'dry_run') {
    const invoice = await withTenant(ctx.org.id, async (tx) => {
      const [row] = await tx.insert(shopifyInvoices).values({ ...base, status: 'dry_run' }).returning();
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'shopify_invoice_test', entityType: 'quote', quoteId, customerId: customer.id,
        newValue: { invoiceId, totalPence: plan.totalPence, quotes: rows.map((r) => r.quoteNumber) },
      });
      return row;
    });
    return { mode, invoice, plan };
  }

  // Save first, so a payment can always be matched back even if Shopify is quick.
  await withTenant(ctx.org.id, async (tx) => {
    await tx.insert(shopifyInvoices).values({ ...base, status: 'awaiting_payment' });
    await tx.update(quotes).set({ shopifyInvoiceId: invoiceId, updatedAt: new Date() }).where(inArray(quotes.id, ids));
  });
  const fail = async (msg: string) => {
    await withTenant(ctx.org.id, async (tx) => {
      await tx.update(shopifyInvoices).set({ status: 'cancelled' }).where(eq(shopifyInvoices.id, invoiceId));
      await tx.update(quotes).set({ shopifyInvoiceId: null }).where(inArray(quotes.id, ids));
    });
    throw new ServiceError(msg);
  };

  let draft: Awaited<ReturnType<typeof createDraftOrder>>;
  try {
    draft = await createDraftOrder(plan.input);
  } catch (e) {
    if (e instanceof ShopifyInvoiceError) return fail(e.message);
    throw e;
  }
  if (draft.totalPence !== plan.totalPence) {
    await deleteDraftOrder(draft.id);
    return fail(`Shopify worked the total out as ${money(draft.totalPence)}, not ${money(plan.totalPence)}, so the invoice wasn’t sent. Please check the products’ prices on Shopify.`);
  }
  try {
    await sendDraftOrderInvoice(draft.id);
  } catch (e) {
    if (e instanceof ShopifyInvoiceError) {
      await deleteDraftOrder(draft.id);
      return fail(e.message);
    }
    throw e;
  }

  const invoice = await withTenant(ctx.org.id, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(shopifyInvoices)
      .set({ draftOrderId: draft.id, draftOrderName: draft.name, invoiceUrl: draft.invoiceUrl, sentAt: now })
      .where(eq(shopifyInvoices.id, invoiceId))
      .returning();
    for (const q of rows) {
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'shopify_invoice_sent', entityType: 'quote', quoteId: q.id, customerId: customer.id,
        newValue: { invoiceId, draftOrderName: draft.name, totalPence: plan.totalPence, email: customer.email, quotes: rows.map((r) => r.quoteNumber) },
      });
    }
    return row;
  });
  return { mode, invoice, plan };
}

/* ───────────────────────────── Payment received ───────────────────────────── */

/** The parts of Shopify's orders/paid (or orders/create) webhook COS uses. */
export type ShopifyOrderWebhook = {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  financial_status?: string;
  total_price?: string;
  note_attributes?: { name: string; value: string }[];
} & OrderShipping;

export type PaidResult = { matched: false; reason: string } | { matched: true; invoiceId: string; already: boolean; orders: string[]; delivery: string; warnings: string[] };

/** Matches a paid Shopify order back to its COS invoice (via the "COS invoice" attribute) and puts the designs into print. */
export async function markShopifyOrderPaid(order: ShopifyOrderWebhook): Promise<PaidResult> {
  if (order.financial_status && order.financial_status !== 'paid') return { matched: false, reason: `not paid (${order.financial_status})` };
  const ref = order.note_attributes?.find((a) => a.name === COS_INVOICE_ATTR)?.value?.trim();
  if (!ref || !/^[0-9a-f-]{36}$/i.test(ref)) return { matched: false, reason: 'not a COS invoice' };
  const [hit] = await systemDb().select({ id: shopifyInvoices.id, orgId: shopifyInvoices.organisationId }).from(shopifyInvoices).where(eq(shopifyInvoices.id, ref)).limit(1);
  if (!hit) return { matched: false, reason: 'unknown COS invoice' };
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.id, hit.orgId)).limit(1);
  if (!org) return { matched: false, reason: 'shop not found' };

  const shopifyOrderName = String(order.name ?? '');
  const paidPence = Math.round(Number(order.total_price ?? 0) * 100);
  const shopify: Actor = { type: 'system', label: 'Shopify' };
  const warnings: string[] = [];
  const delivery = deliveryFromOrder(order);
  const jobNote = `Paid on Shopify ${shopifyOrderName} · ${delivery.method === 'delivery' ? `Post: ${delivery.label}` : delivery.method === 'collection' ? 'Collection from the shop' : delivery.label} · Print before posting.`;

  const out = await withTenant(org.id, async (tx) => {
    const [inv] = await tx.select().from(shopifyInvoices).where(eq(shopifyInvoices.id, hit.id)).for('update').limit(1);
    if (!inv) return null;
    if (inv.status === 'paid') return { already: true, orders: [] as string[], messages: [] as (string | null)[] };
    if (inv.status === 'dry_run') return null;
    if (paidPence && paidPence !== inv.totalPence) warnings.push(`Shopify order total ${money(paidPence)} differs from the invoice ${money(inv.totalPence)}.`);
    // Payments are recorded against the staff member who sent the invoice, with Shopify as the actor.
    const ctx: Ctx = { org, actor: shopify, userId: inv.createdByUserId, role: null };
    const qs = await tx.select().from(quotes).where(inArray(quotes.id, inv.quoteIds)).for('update', { of: quotes });
    const cs = qs.length ? await tx.select().from(customers).where(inArray(customers.id, [...new Set(qs.map((q) => q.customerId))])) : [];
    const amount = paidPence || inv.totalPence;
    const totalOfQuotes = qs.reduce((n, q) => n + q.totalGrossPence, 0) || 1;
    let allocated = 0;
    const orderNumbers: string[] = [];
    const messages: (string | null)[] = [];
    const orderFor = new Map<string, string>();
    for (const [i, q] of inv.quoteIds.map((id) => qs.find((x) => x.id === id)).entries()) {
      if (!q) continue;
      const share = i === inv.quoteIds.length - 1 ? amount - allocated : Math.round((amount * q.totalGrossPence) / totalOfQuotes);
      allocated += share;
      let orderId = q.convertedOrderId;
      if ((OPEN as readonly string[]).includes(q.status) && !q.archivedAt) {
        const customer = cs.find((c) => c.id === q.customerId)!;
        const r = await acceptAndConvert(tx, ctx, q, customer, `Paid online (Shopify ${shopifyOrderName})`, { shopifyOrder: shopifyOrderName, invoiceId: inv.id }, { ignoreExpiry: true });
        orderId = r.order.id;
        orderNumbers.push(r.order.orderNumber);
        messages.push(r.messageId);
      } else if (!orderId) {
        warnings.push(`${q.quoteNumber} is ${q.status}, so it wasn’t put into print. Check it, and refund on Shopify if needed.`);
        continue;
      }
      orderFor.set(q.id, orderId);
      await tx
        .update(orders)
        .set({ internalNotes: sql`case when ${orders.internalNotes} = '' then ${jobNote} else ${orders.internalNotes} || ${`\n\n${jobNote}`} end` })
        .where(eq(orders.id, orderId));
      if (share > 0) await insertPayment(tx, ctx, orderId, { kind: 'payment', amountPence: share, method: 'card', reference: `Shopify ${shopifyOrderName}`.trim() });
    }
    await tx
      .update(shopifyInvoices)
      .set({ status: 'paid', paidAt: new Date(), deliveryMethod: delivery.method, deliveryLabel: delivery.label, shopifyOrderId: String(order.admin_graphql_api_id ?? order.id ?? ''), shopifyOrderName, warnings: [...inv.warnings, ...warnings] })
      .where(eq(shopifyInvoices.id, inv.id));
    for (const q of qs) {
      await recordEvent(tx, {
        organisationId: org.id, actor: shopify, eventType: 'shopify_invoice_paid', entityType: 'quote', quoteId: q.id, customerId: q.customerId,
        orderId: orderFor.get(q.id), newValue: { invoiceId: inv.id, shopifyOrderName, paidPence: amount, delivery: delivery.method, deliveryLabel: delivery.label }, metadata: warnings.length ? { warnings } : undefined,
      });
    }
    return { already: false, orders: orderNumbers, messages };
  });
  if (!out) return { matched: false, reason: 'invoice not payable' };
  if (out.messages.length) await dispatchMessages(org, out.messages);
  return { matched: true, invoiceId: hit.id, already: out.already, orders: out.orders, delivery: delivery.method, warnings };
}

/* ─────────────────────────────── Staff lists ─────────────────────────────── */

export type PayState = {
  invoiceId: string; status: ShopifyInvoice['status']; label: string; overdue: boolean; sentAt: Date | null; paidAt: Date | null;
  draftOrderName: string | null; invoiceUrl: string | null; shopifyOrderName: string | null; deliveryMethod: string | null; deliveryLabel: string | null; totalPence: number; warnings: string[]; quoteIds: string[];
};

export function payStateOf(inv: ShopifyInvoice, now = new Date()): PayState {
  const overdue = inv.status === 'awaiting_payment' && Boolean(inv.sentAt) && now.getTime() - inv.sentAt!.getTime() > UNPAID_FLAG_DAYS * 86_400_000;
  const label =
    inv.status === 'paid' ? 'Paid – ready to print' : inv.status === 'awaiting_payment' ? (overdue ? `Awaiting payment (over ${UNPAID_FLAG_DAYS} days)` : 'Awaiting payment') : inv.status === 'dry_run' ? 'Test invoice' : 'Invoice cancelled';
  return {
    invoiceId: inv.id, status: inv.status, label, overdue, sentAt: inv.sentAt, paidAt: inv.paidAt, draftOrderName: inv.draftOrderName, invoiceUrl: inv.invoiceUrl,
    shopifyOrderName: inv.shopifyOrderName, deliveryMethod: inv.deliveryMethod, deliveryLabel: inv.deliveryLabel, totalPence: inv.totalPence, warnings: inv.warnings, quoteIds: inv.quoteIds,
  };
}

/** Payment state per quote id (live invoices only: awaiting payment or paid). */
export async function payStatesForQuotes(orgId: string, quoteIds: string[]) {
  const out = new Map<string, PayState>();
  if (!quoteIds.length) return out;
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ inv: shopifyInvoices, quoteId: quotes.id })
      .from(quotes)
      .innerJoin(shopifyInvoices, eq(shopifyInvoices.id, quotes.shopifyInvoiceId))
      .where(and(inArray(quotes.id, quoteIds), inArray(shopifyInvoices.status, ['awaiting_payment', 'paid']))),
  );
  for (const r of rows) out.set(r.quoteId, payStateOf(r.inv));
  return out;
}

/** The latest invoice (any status, including test ones) on a quote, for the quote screen. */
export async function latestInvoiceForQuote(orgId: string, quoteId: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(shopifyInvoices).where(sql`${shopifyInvoices.quoteIds} @> ${JSON.stringify([quoteId])}::jsonb`).orderBy(sql`${shopifyInvoices.createdAt} desc`).limit(1),
  );
  return rows[0] ?? null;
}

/** All invoices waiting for payment, oldest first, for the Quotes page. */
export async function awaitingPayment(orgId: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ inv: shopifyInvoices, customer: customers.name })
      .from(shopifyInvoices)
      .innerJoin(customers, eq(customers.id, shopifyInvoices.customerId))
      .where(eq(shopifyInvoices.status, 'awaiting_payment'))
      .orderBy(shopifyInvoices.sentAt),
  );
  const ids = rows.flatMap((r) => r.inv.quoteIds);
  const nums = ids.length ? await withTenant(orgId, (tx) => tx.select({ id: quotes.id, n: quotes.quoteNumber }).from(quotes).where(inArray(quotes.id, ids))) : [];
  return rows.map((r) => ({ ...payStateOf(r.inv), customer: r.customer, quoteNumbers: r.inv.quoteIds.map((id) => nums.find((x) => x.id === id)?.n ?? '?') }));
}

/** "Send Shopify invoice" on an order that was approved but not paid (e.g. approved in store). */
export async function sendInvoiceForOrder(ctx: Ctx, orderId: string, opts: { mode?: InvoiceMode } = {}) {
  const [o] = await withTenant(ctx.org.id, (tx) => tx.select({ quoteId: orders.quoteId }).from(orders).where(eq(orders.id, orderId)).limit(1));
  if (!o?.quoteId) throw new ServiceError('Only orders made from a ball design can be invoiced through Shopify.');
  return approveAndSendInvoice(ctx, o.quoteId, [], opts);
}

/**
 * The customer approves the proof on their emailed link. For pay-before-print designs that sends the
 * Shopify invoice instead of starting print; returns the payment link (live) so they can pay now.
 */
export async function approveByCustomerAndInvoice(found: { org: Organisation; quote: Quote }, name: string) {
  const ctx: Ctx = { org: found.org, actor: { type: 'customer', name }, userId: found.quote.createdByUserId, role: null };
  const existing = await latestInvoiceForQuote(found.org.id, found.quote.id);
  if (existing?.status === 'awaiting_payment') return { invoiceUrl: existing.invoiceUrl, mode: invoiceMode() };
  const r = await approveAndSendInvoice(ctx, found.quote.id);
  return { invoiceUrl: r.invoice.invoiceUrl, mode: r.mode };
}
