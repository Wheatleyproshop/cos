import 'server-only';
import { likeTerm } from './like-term';
import { DEFAULT_BRANDS, mergeBrands } from './order-details';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant } from '@/db';
import {
  attachments,
  auditEvents,
  backupDestinations,
  backupRuns,
  brands,
  customers,
  messages,
  orders,
  payments,
  quotes,
  supplierAccounts,
  users,
  workshopJobs,
  type Organisation,
  type OrderStatus,
} from '@/db/schema';
import { orderAttention, quoteAttention, type AttentionFlag } from './attention';
import { todayInTz } from './format';
import { livePayment } from './services/common';
import { QUOTE_STATUS_LABELS, statusLabel, step } from './status';

export type WorkRow = {
  kind: 'order' | 'quote';
  id: string;
  number: string;
  brand: string;
  product: string;
  sku: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  totalPence: number;
  date: string | null; // ETA for orders, valid-until for quotes
  status: OrderStatus | 'quote';
  statusText: string;
  supplierReference: string;
  flags: AttentionFlag[];
  archived: boolean;
  createdAt: Date;
};

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'quote', label: 'Quote' },
  { key: 'place_order', label: 'To place' },
  { key: 'ordered', label: 'Placed' },
  { key: 'delayed', label: 'Out of stock / delayed' },
  { key: 'ready', label: 'Ready for collection' },
  { key: 'collected', label: 'Collected' },
] as const;

export type FilterKey = (typeof FILTERS)[number]['key'] | 'active' | 'awaiting' | 'placed' | 'overdue' | 'archived';


function orderSearch(q: string): SQL | undefined {
  if (!q) return undefined;
  const t = likeTerm(q);
  const digits = q.replace(/\D/g, '');
  return or(
    ilike(orders.orderNumber, t),
    ilike(orders.brand, t),
    ilike(orders.product, t),
    ilike(orders.sku, t),
    ilike(orders.supplierReference, t),
    ilike(customers.name, t),
    ilike(customers.email, t),
    ilike(customers.phone, t),
    digits.length >= 4 ? sql`regexp_replace(${customers.phone}, '\\D', '', 'g') like ${'%' + digits + '%'}` : undefined,
  );
}

function quoteSearch(q: string): SQL | undefined {
  if (!q) return undefined;
  const t = likeTerm(q);
  return or(
    ilike(quotes.quoteNumber, t),
    ilike(quotes.brand, t),
    ilike(quotes.product, t),
    ilike(quotes.sku, t),
    ilike(customers.name, t),
    ilike(customers.email, t),
    ilike(customers.phone, t),
  );
}

/** Orders + open quotes in one operational list, with attention flags. */
export async function listWork(
  org: Organisation,
  opts: { q?: string; filter?: FilterKey; scope?: 'overview' | 'all' },
): Promise<{ rows: WorkRow[]; all: WorkRow[] }> {
  const q = (opts.q ?? '').trim().slice(0, 100);
  const filter = opts.filter ?? 'all';
  const today = todayInTz(org.timezone);
  const recent = new Date(Date.now() - 30 * 86_400_000);

  return withTenant(org.id, async (tx) => {
    const orderRows = await tx
      .select({ o: orders, c: customers })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          filter === 'archived' ? and(sql`${orders.archivedAt} is not null`, isNull(orders.removedAt)) : isNull(orders.archivedAt),
          opts.scope === 'overview' && filter === 'all'
            ? or(sql`${orders.status} <> 'collected'`, sql`${orders.collectedAt} > ${recent.toISOString()}`)
            : undefined,
          orderSearch(q),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(500);

    const quoteRows =
      filter === 'archived'
        ? []
        : await tx
            .select({ qt: quotes, c: customers })
            .from(quotes)
            .innerJoin(customers, eq(customers.id, quotes.customerId))
            .where(and(isNull(quotes.archivedAt), inArray(quotes.status, ['draft', 'sent']), quoteSearch(q)))
            .orderBy(desc(quotes.createdAt))
            .limit(200);

    const all: WorkRow[] = [
      ...orderRows.map(({ o, c }) => ({
        kind: 'order' as const,
        id: o.id,
        number: o.orderNumber,
        brand: o.brand,
        product: o.product,
        sku: o.sku,
        customerId: c.id,
        customerName: c.name,
        customerEmail: c.email,
        totalPence: o.totalGrossPence,
        date: o.etaDate,
        status: o.status,
        statusText: statusLabel(o.status),
        supplierReference: o.supplierReference,
        flags: orderAttention(o, org, today),
        archived: Boolean(o.archivedAt),
        createdAt: o.createdAt,
      })),
      ...quoteRows.map(({ qt, c }) => ({
        kind: 'quote' as const,
        id: qt.id,
        number: qt.quoteNumber,
        brand: qt.brand,
        product: qt.product,
        sku: qt.sku,
        customerId: c.id,
        customerName: c.name,
        customerEmail: c.email,
        totalPence: qt.totalGrossPence,
        date: qt.validUntil,
        status: 'quote' as const,
        statusText: QUOTE_STATUS_LABELS[qt.status],
        supplierReference: '',
        flags: quoteAttention(qt, org),
        archived: false,
        createdAt: qt.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const rows = all.filter((r) => matchesFilter(r, filter));
    return { rows, all };
  });
}

function matchesFilter(r: WorkRow, f: FilterKey): boolean {
  switch (f) {
    case 'all':
    case 'archived':
      return true;
    case 'attention':
      return r.flags.length > 0;
    case 'quote':
      return r.kind === 'quote';
    case 'active':
      return r.kind === 'order' && r.status !== 'collected';
    case 'awaiting':
      return r.kind === 'order' && r.status !== 'quote' && step(r.status).awaitingSupplier;
    case 'placed':
      return r.kind === 'order' && (r.status === 'ordered' || r.status === 'delayed');
    case 'overdue':
      return r.kind === 'order' && r.flags.some((x) => x.code === 'eta_passed' || x.code === 'delayed');
    default:
      return r.kind === 'order' && r.status === f;
  }
}

export function metrics(all: WorkRow[]) {
  const ordersOnly = all.filter((r) => r.kind === 'order' && !r.archived);
  return {
    active: ordersOnly.filter((r) => r.status !== 'collected').length,
    awaiting: ordersOnly.filter((r) => matchesFilter(r, 'awaiting')).length,
    overdue: ordersOnly.filter((r) => matchesFilter(r, 'overdue')).length,
    ready: ordersOnly.filter((r) => r.status === 'ready').length,
    quotes: all.filter((r) => r.kind === 'quote').length,
    attention: all.filter((r) => r.flags.length > 0).length,
  };
}

const takenBy = alias(users, 'taken_by');

export async function getOrderDetail(org: Organisation, orderNumber: string) {
  return withTenant(org.id, async (tx) => {
    const [row] = await tx
      .select({ order: orders, customer: customers, takenByName: takenBy.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(takenBy, eq(takenBy.id, orders.takenByUserId))
      .where(eq(orders.orderNumber, orderNumber))
      .limit(1);
    if (!row) return null;
    const id = row.order.id;
    const [paymentRows, attachmentRows, messageRows, events, sourceQuote] = await Promise.all([
      tx
        .select({ p: payments, by: users.name })
        .from(payments)
        .innerJoin(users, eq(users.id, payments.recordedByUserId))
        .where(eq(payments.orderId, id))
        .orderBy(asc(payments.createdAt)),
      tx
        .select({ a: attachments, by: users.name })
        .from(attachments)
        .innerJoin(users, eq(users.id, attachments.uploadedByUserId))
        .where(eq(attachments.orderId, id))
        .orderBy(desc(attachments.createdAt)),
      tx
        .select({
          id: messages.id, templateType: messages.templateType, recipient: messages.recipient, subject: messages.subject,
          status: messages.status, simulated: messages.simulated, error: messages.error, createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.orderId, id))
        .orderBy(desc(messages.createdAt)),
      tx
        .select()
        .from(auditEvents)
        .where(row.order.quoteId ? or(eq(auditEvents.orderId, id), eq(auditEvents.quoteId, row.order.quoteId)) : eq(auditEvents.orderId, id))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)),
      row.order.quoteId
        ? tx.select({ number: quotes.quoteNumber }).from(quotes).where(eq(quotes.id, row.order.quoteId)).limit(1)
        : Promise.resolve([]),
    ]);
    // Voids and the payments they cancel don't count.
    const voidedIds = new Set(paymentRows.map(({ p }) => p.voidsPaymentId).filter(Boolean));
    const paid = paymentRows
      .filter(({ p }) => p.kind !== 'void' && !voidedIds.has(p.id))
      .reduce((s, { p }) => s + (p.kind === 'refund' ? -p.amountPence : p.amountPence), 0);
    const credit = paymentRows.reduce((s, { p }) => s + (p.kind === 'credit' ? p.amountPence : 0), 0);
    return {
      ...row,
      payments: paymentRows,
      attachments: attachmentRows.filter(({ a }) => !a.archivedAt),
      deletedAttachments: attachmentRows.filter(({ a }) => a.archivedAt),
      messages: messageRows,
      events,
      paid,
      credit,
      balance: row.order.totalGrossPence - paid,
      flags: orderAttention(row.order, org, todayInTz(org.timezone)),
      sourceQuoteNumber: sourceQuote[0]?.number ?? null,
    };
  });
}

export async function getQuoteDetail(org: Organisation, quoteNumber: string) {
  return withTenant(org.id, async (tx) => {
    const [row] = await tx
      .select({ quote: quotes, customer: customers, createdByName: users.name })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .innerJoin(users, eq(users.id, quotes.createdByUserId))
      .where(eq(quotes.quoteNumber, quoteNumber))
      .limit(1);
    if (!row) return null;
    const [events, messageRows, converted] = await Promise.all([
      tx.select().from(auditEvents).where(eq(auditEvents.quoteId, row.quote.id)).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)),
      tx
        .select({ id: messages.id, templateType: messages.templateType, recipient: messages.recipient, status: messages.status, simulated: messages.simulated, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.quoteId, row.quote.id))
        .orderBy(desc(messages.createdAt)),
      row.quote.convertedOrderId
        ? tx.select({ number: orders.orderNumber }).from(orders).where(eq(orders.id, row.quote.convertedOrderId)).limit(1)
        : Promise.resolve([]),
    ]);
    return { ...row, events, messages: messageRows, convertedOrderNumber: converted[0]?.number ?? null, flags: quoteAttention(row.quote, org) };
  });
}

export async function listQuotes(org: Organisation, opts: { q?: string; status?: string }) {
  const q = (opts.q ?? '').trim().slice(0, 100);
  return withTenant(org.id, async (tx) => {
    const rows = await tx
      .select({ quote: quotes, customer: customers, createdByName: users.name })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .innerJoin(users, eq(users.id, quotes.createdByUserId))
      .where(
        and(
          isNull(quotes.archivedAt),
          opts.status === 'open' || !opts.status
            ? inArray(quotes.status, ['draft', 'sent'])
            : opts.status === 'closed'
              ? inArray(quotes.status, ['accepted', 'declined', 'expired', 'cancelled'])
              : undefined,
          quoteSearch(q),
        ),
      )
      .orderBy(desc(quotes.createdAt))
      .limit(300);
    return rows.map((r) => ({ ...r, flags: quoteAttention(r.quote, org) }));
  });
}

/** A club's full membership list fits; beyond this the page asks you to search. */
export const CUSTOMER_LIST_LIMIT = 3000;

export async function listCustomers(org: Organisation, qRaw?: string) {
  const q = (qRaw ?? '').trim().slice(0, 100);
  const t = likeTerm(q);
  const digits = q.replace(/\D/g, '');
  return withTenant(org.id, async (tx) =>
    tx
      .select({
        c: customers,
        activeOrders: sql<number>`(select count(*)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null and o.status <> 'collected')`,
        totalOrders: sql<number>`(select count(*)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        lifetimePence: sql<number>`(select coalesce(sum(o.total_gross_pence),0)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        lastOrderAt: sql<Date | null>`(select max(o.created_at) from ${orders} o where o.customer_id = "customers"."id")`,
        workshopJobs: sql<number>`(select count(*)::int from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null and w.status <> 'cancelled')`,
        openWorkshopJobs: sql<number>`(select count(*)::int from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null and w.status in ('checked_in', 'in_progress', 'waiting_parts', 'ready'))`,
      })
      .from(customers)
      .where(
        and(
          isNull(customers.archivedAt),
          q
            ? or(
                q.includes(' ') ? and(...q.split(/\s+/).slice(0, 5).map((w) => ilike(customers.name, likeTerm(w)))) : ilike(customers.name, t),
                ilike(customers.email, t),
                ilike(customers.phone, t),
                digits.length >= 4 ? sql`regexp_replace(${customers.phone}, '\\D', '', 'g') like ${'%' + digits + '%'}` : undefined,
                // A workshop job number (e.g. WS-1002) finds its customer.
                sql`exists (select 1 from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null and w.reference ilike ${t})`,
              )
            : undefined,
        ),
      )
      .orderBy(asc(customers.name))
      .limit(CUSTOMER_LIST_LIMIT),
  );
}

export async function getCustomerDetail(org: Organisation, customerId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return null;
  return withTenant(org.id, async (tx) => {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    if (!customer) return null;
    const [orderRows, quoteRows, paidRows] = await Promise.all([
      tx.select().from(orders).where(and(eq(orders.customerId, customerId), isNull(orders.removedAt))).orderBy(desc(orders.createdAt)),
      tx.select().from(quotes).where(and(eq(quotes.customerId, customerId), isNull(quotes.archivedAt))).orderBy(desc(quotes.createdAt)),
      tx
        .select({
          total: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amountPence} else ${payments.amountPence} end),0)::int`,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(and(eq(orders.customerId, customerId), isNull(orders.removedAt), livePayment())),
    ]);
    const live = orderRows.filter((o) => !o.archivedAt);
    // Saved builds: distinct specifications this customer has ordered before.
    const seen = new Set<string>();
    const builds = live
      .filter((o) => {
        const k = `${o.brand}|${o.product}|${o.specificationText}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((o) => ({ orderNumber: o.orderNumber, brand: o.brand, product: o.product, sku: o.sku, spec: o.specificationText, date: o.createdAt }));
    return {
      customer,
      activeOrders: live.filter((o) => o.status !== 'collected'),
      pastOrders: orderRows.filter((o) => o.status === 'collected' || o.archivedAt),
      quotes: quoteRows,
      lifetimePence: live.reduce((s, o) => s + o.totalGrossPence, 0),
      paidPence: Number(paidRows[0]?.total ?? 0),
      builds,
    };
  });
}

export async function listMessages(org: Organisation, limit = 50) {
  return withTenant(org.id, async (tx) =>
    tx
      .select({
        m: {
          id: messages.id, templateType: messages.templateType, recipient: messages.recipient, subject: messages.subject,
          status: messages.status, simulated: messages.simulated, error: messages.error, createdAt: messages.createdAt,
        },
        orderNumber: orders.orderNumber,
        quoteNumber: quotes.quoteNumber,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .leftJoin(quotes, eq(quotes.id, messages.quoteId))
      .orderBy(desc(messages.createdAt))
      .limit(limit),
  );
}

export async function getMessage(org: Organisation, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withTenant(org.id, async (tx) => (await tx.select().from(messages).where(eq(messages.id, id)).limit(1))[0] ?? null);
}

export async function getSettingsData(org: Organisation) {
  return withTenant(org.id, async (tx) => {
    const [team, destinations, runs] = await Promise.all([
      tx
        .select({
          id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, lastLoginAt: users.lastLoginAt,
          loginEnabled: users.loginEnabled, sharedLogin: users.sharedLogin,
        })
        .from(users)
        .where(isNull(users.removedAt))
        .orderBy(desc(users.active), asc(users.name)),
      tx.select({ provider: backupDestinations.provider, status: backupDestinations.status }).from(backupDestinations),
      tx.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(5),
    ]);
    return { team, destinations, runs };
  });
}

/** Latest real order for email previews; falls back to sample data. */
export async function previewSource(org: Organisation) {
  return withTenant(org.id, async (tx) => {
    const [row] = await tx
      .select({ o: orders, c: customers })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(isNull(orders.archivedAt))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    return row ?? null;
  });
}

/** Brands for the order form: your accounts and catalogue first, anything you've ordered before, plus common golf brands. */
export async function getBrandOptions(orgId: string): Promise<string[]> {
  const [cat, accounts, used] = await withTenant(orgId, (tx) =>
    Promise.all([
      tx.select({ name: brands.name }).from(brands).where(eq(brands.active, true)),
      tx.select({ name: supplierAccounts.brand }).from(supplierAccounts).where(isNull(supplierAccounts.removedAt)),
      tx.selectDistinct({ name: orders.brand }).from(orders).where(sql`${orders.createdAt} > now() - interval '2 years'`),
    ]),
  );
  return mergeBrands(
    cat.map((r) => r.name),
    accounts.map((r) => r.name),
    DEFAULT_BRANDS,
    used.map((r) => r.name),
  );
}
