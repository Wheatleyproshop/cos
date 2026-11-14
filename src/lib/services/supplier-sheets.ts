import { and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { withTenant } from '@/db';
import { auditEvents, customers, orders, supplierAccounts, type Organisation } from '@/db/schema';
import { asBallPrintSpec } from '../ball-print';
import { addDays, todayInTz } from '../format';
import { asMatSpec } from '../mat-engraving';
import { asItemsSpec, itemStatus } from '../order-items';
import { ServiceError, type Ctx } from './common';
import { quickMove, updateOrderItem } from './orders';

/**
 * Supplier order sheets: everything waiting to be ordered, grouped by supplier, ready to email, copy
 * or print as one order per supplier; and everything placed that has gone quiet, to chase.
 * A "line" is a whole order, or one item on a multi-item order (items can come from different brands).
 */

export type SheetLine = {
  orderId: string;
  orderNumber: string;
  /** Position on a multi-item order (0-based), or null for the whole order. */
  itemIndex: number | null;
  brand: string;
  product: string;
  details: string[];
  sku: string;
  quantity: number;
  customer: string;
  takenAt: Date;
  // For chasing
  placedAt: Date | null;
  etaDate: string | null;
  supplierReference: string;
  status: string;
  overdue: boolean;
};

export type SupplierAccountInfo = {
  brand: string; accountNumber: string; ordersEmail: string; repName: string; repEmail: string; repPhone: string; headOfficePhone: string; portalUrl: string;
};

export type SupplierGroup = { key: string; supplier: string; account: SupplierAccountInfo | null; lines: SheetLine[]; lead: LeadTime | null };

const DETAIL_SKIP = /^(product id|sku|quantity|qty|price|total|deposit)\b/i;

/** The spec text as short detail lines for the supplier (prices and our internal bits left out). */
function detailLines(spec: string, max = 4) {
  return spec
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !DETAIL_SKIP.test(l) && !/£/.test(l))
    .slice(0, max);
}

const keyOf = (s: string) => s.trim().toLowerCase();

/** Orders made in-house (personalised balls, engraved mats) aren't ordered from a supplier. */
const inHouse = (json: unknown) => Boolean(asBallPrintSpec(json) || asMatSpec(json));

export type LeadTime = {
  key: string; supplier: string; measured: number; medianDays: number; avgDays: number; fastestDays: number; slowestDays: number;
  /** Median of the most recent five, to show whether a supplier is getting quicker or slower. */
  recentMedianDays: number | null;
  onOrderNow: number;
};

const DAY = 86_400_000;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How long each supplier takes: from the day an order (or an item on a multi-item order) was placed
 * with them to the day it arrived in store. Placed-with-supplier times come from the audit trail.
 */
export async function supplierLeadTimes(org: Organisation, sinceDays = 365) {
  const since = new Date(Date.now() - sinceDays * DAY);
  const { arrived, events } = await withTenant(org.id, async (tx) => {
    const arrived = await tx
      .select({ id: orders.id, brand: orders.brand, supplier: orders.supplier, readyAt: orders.readyAt, spec: orders.specificationJson })
      .from(orders)
      .where(and(isNull(orders.removedAt), gte(orders.createdAt, since)));
    const ids = arrived.map((o) => o.id);
    const events = ids.length
      ? await tx
          .select({ orderId: auditEvents.orderId, type: auditEvents.eventType, v: auditEvents.newValueJson, at: auditEvents.createdAt })
          .from(auditEvents)
          .where(and(inArray(auditEvents.eventType, ['status_changed', 'order_item_changed']), isNotNull(auditEvents.orderId), gte(auditEvents.createdAt, since)))
          .orderBy(auditEvents.createdAt)
      : [];
    return { arrived, events };
  });
  const byOrder = new Map<string, typeof events>();
  for (const e of events) {
    if (!e.orderId) continue;
    const list = byOrder.get(e.orderId) ?? [];
    list.push(e);
    byOrder.set(e.orderId, list);
  }
  const samples = new Map<string, { name: string; d: { days: number; at: number }[] }>();
  const add = (brand: string, placed: Date | undefined, landed: Date | null | undefined) => {
    if (!placed || !landed || landed <= placed) return;
    const key = keyOf(brand);
    if (!key) return;
    const g = samples.get(key) ?? { name: brand.trim(), d: [] };
    g.d.push({ days: (landed.getTime() - placed.getTime()) / DAY, at: landed.getTime() });
    samples.set(key, g);
  };
  for (const o of arrived) {
    if (inHouse(o.spec)) continue;
    const evs = byOrder.get(o.id) ?? [];
    const items = asItemsSpec(o.spec);
    if (items) {
      items.items.forEach((it, i) => {
        const mine = evs.filter((e) => e.type === 'order_item_changed' && (e.v as { index?: number } | null)?.index === i + 1);
        const st = (e: (typeof evs)[number]) => (e.v as { status?: string } | null)?.status;
        const placed = mine.find((e) => st(e) === 'ordered' || st(e) === 'delayed')?.at;
        const landed = mine.find((e) => st(e) === 'arrived' || st(e) === 'collected')?.at;
        add(it.brand, placed, landed);
      });
      continue;
    }
    const placed = evs.find((e) => e.type === 'status_changed' && (e.v as { status?: string } | null)?.status === 'ordered')?.at;
    add(o.supplier.trim() || o.brand, placed, o.readyAt);
  }
  const out = new Map<string, Omit<LeadTime, 'onOrderNow'>>();
  for (const [key, g] of samples) {
    const days = g.d.map((x) => x.days);
    const recent = [...g.d].sort((a, b) => b.at - a.at).slice(0, 5).map((x) => x.days);
    out.set(key, {
      key, supplier: g.name, measured: days.length, medianDays: r1(median(days)), avgDays: r1(days.reduce((a, b) => a + b, 0) / days.length),
      fastestDays: r1(Math.min(...days)), slowestDays: r1(Math.max(...days)), recentMedianDays: days.length >= 6 ? r1(median(recent)) : null,
    });
  }
  return out;
}

export async function supplierSheets(org: Organisation) {
  const today = todayInTz(org.timezone);
  const { rows, accounts } = await withTenant(org.id, async (tx) => {
    const rows = await tx
      .select({ o: orders, customer: customers.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(inArray(orders.status, ['place_order', 'ordered', 'delayed']), isNull(orders.archivedAt), isNull(orders.removedAt)));
    const accounts = await tx
      .select()
      .from(supplierAccounts)
      .where(and(eq(supplierAccounts.active, true), isNull(supplierAccounts.removedAt)));
    return { rows, accounts };
  });

  const lead = await supplierLeadTimes(org);
  // A placed line with no expected date is "quiet" once it's taken noticeably longer than that supplier usually does
  // (or the shop's chase setting, for suppliers without enough history yet).
  const quietAfter = (brand: string) => {
    const l = lead.get(keyOf(brand));
    return l && l.measured >= 3 ? Math.max(3, Math.ceil(l.medianDays * 1.25)) : org.supplierChaseDays;
  };
  const isQuiet = (brand: string, placed: Date) => Date.now() - placed.getTime() > quietAfter(brand) * DAY;
  const toOrder: SheetLine[] = [];
  const toChase: SheetLine[] = [];
  for (const { o, customer } of rows) {
    if (inHouse(o.specificationJson)) continue;
    const items = asItemsSpec(o.specificationJson);
    const base = { orderId: o.id, orderNumber: o.orderNumber, customer, takenAt: o.createdAt };
    if (items) {
      items.items.forEach((it, i) => {
        const st = itemStatus(it);
        const line: SheetLine = {
          ...base, itemIndex: i, brand: it.brand, product: it.product,
          details: [it.variant, it.colour, it.size && `Size ${it.size}`, it.hand && `${it.hand}-handed`, it.notes].filter(Boolean) as string[],
          sku: it.sku, quantity: it.quantity, placedAt: null, etaDate: it.etaDate ?? null, supplierReference: it.supplierReference ?? '', status: st, overdue: false,
        };
        if (st === 'to_order') {
          if (o.status === 'place_order' || o.status === 'ordered' || o.status === 'delayed') toOrder.push(line);
        } else if (st === 'ordered' || st === 'delayed') {
          line.overdue = Boolean(line.etaDate && line.etaDate < today);
          if (line.overdue || (!line.etaDate && isQuiet(it.brand, o.createdAt))) toChase.push(line);
        }
      });
      continue;
    }
    const line: SheetLine = {
      ...base, itemIndex: null, brand: o.supplier.trim() || o.brand, product: keyOf(o.supplier || o.brand) === keyOf(o.brand) ? o.product : `${o.brand} ${o.product}`.trim(),
      details: detailLines(o.specificationText), sku: o.sku, quantity: 1, placedAt: o.status === 'place_order' ? null : o.statusChangedAt,
      etaDate: o.etaDate, supplierReference: o.supplierReference, status: o.status, overdue: false,
    };
    if (o.status === 'place_order') toOrder.push(line);
    else {
      line.overdue = Boolean(o.etaDate && o.etaDate < today);
      if (line.overdue || (!o.etaDate && isQuiet(line.brand, o.statusChangedAt))) toChase.push(line);
    }
  }

  const acct = new Map(accounts.map((a) => [keyOf(a.brand), a]));
  const group = (lines: SheetLine[]): SupplierGroup[] => {
    const m = new Map<string, SupplierGroup>();
    for (const l of lines) {
      const key = keyOf(l.brand) || 'unknown';
      const a = acct.get(key);
      const g = m.get(key) ?? {
        key,
        supplier: a?.brand ?? (l.brand || 'No brand'),
        account: a
          ? {
              brand: a.brand, accountNumber: a.accountNumber, ordersEmail: a.ordersEmail, repName: a.repName, repEmail: a.repEmail, repPhone: a.repPhone,
              headOfficePhone: a.headOfficePhone, portalUrl: a.portalUrl,
            }
          : null,
        lines: [],
        lead: null,
      };
      g.lines.push(l);
      m.set(key, g);
    }
    for (const g of m.values()) g.lines.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
    return [...m.values()].sort((a, b) => b.lines.length - a.lines.length || a.supplier.localeCompare(b.supplier));
  };
  // On order now, per supplier (placed, not yet arrived), for the lead times table.
  const onOrder = new Map<string, number>();
  for (const { o } of rows) {
    if (inHouse(o.specificationJson)) continue;
    const items = asItemsSpec(o.specificationJson);
    if (items) {
      for (const it of items.items) if (['ordered', 'delayed'].includes(itemStatus(it))) onOrder.set(keyOf(it.brand), (onOrder.get(keyOf(it.brand)) ?? 0) + 1);
    } else if (o.status !== 'place_order') onOrder.set(keyOf(o.supplier || o.brand), (onOrder.get(keyOf(o.supplier || o.brand)) ?? 0) + 1);
  }
  const leadTimes: LeadTime[] = [...lead.values()]
    .map((l) => ({ ...l, supplier: acct.get(l.key)?.brand ?? l.supplier, onOrderNow: onOrder.get(l.key) ?? 0 }))
    .sort((a, b) => b.measured - a.measured || a.medianDays - b.medianDays);
  const withLead = (gs: SupplierGroup[]) => gs.map((g) => ({ ...g, lead: leadTimes.find((l) => l.key === g.key) ?? null }));
  return { toOrder: withLead(group(toOrder)), toChase: withLead(group(toChase)), leadTimes, chaseDays: org.supplierChaseDays, today, quietAfter };
}

export type SupplierSheets = Awaited<ReturnType<typeof supplierSheets>>;

const lineText = (l: SheetLine, i: number) =>
  [
    `${i + 1}. ${l.product}${l.quantity > 1 ? ` x ${l.quantity}` : ''}   (our ref ${l.orderNumber})`,
    ...l.details.map((d) => `   ${d}`),
    ...(l.sku ? [`   Product code: ${l.sku}`] : []),
  ].join('\n');

/** The order as a plain-text email to the supplier. */
export function orderEmail(org: Pick<Organisation, 'storeName' | 'storePhone' | 'collectionLocation'>, g: SupplierGroup, sender: string) {
  const acc = g.account?.accountNumber ? ` (account ${g.account.accountNumber})` : '';
  const n = g.lines.reduce((s, l) => s + l.quantity, 0);
  const subject = `Order from ${org.storeName}${acc} - ${n} item${n === 1 ? '' : 's'}`;
  const body = [
    g.account?.repName ? `Hi ${g.account.repName.split(' ')[0]},` : 'Hello,',
    '',
    `Please could you place the following order for ${org.storeName}${acc}:`,
    '',
    g.lines.map(lineText).join('\n\n'),
    '',
    'Please confirm with your order reference and expected delivery date for each line.',
    '',
    'Thanks,',
    sender,
    [org.storeName, org.storePhone].filter(Boolean).join(' · '),
  ].join('\n');
  return { to: g.account?.ordersEmail || g.account?.repEmail || '', subject, body };
}

/** Chasing placed orders that are late or have gone quiet. */
export function chaseEmail(org: Pick<Organisation, 'storeName' | 'storePhone'>, g: SupplierGroup, sender: string) {
  const acc = g.account?.accountNumber ? ` (account ${g.account.accountNumber})` : '';
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const subject = `Order update please - ${org.storeName}${acc}`;
  const body = [
    g.account?.repName ? `Hi ${g.account.repName.split(' ')[0]},` : 'Hello,',
    '',
    `Could you give us an update on these orders for ${org.storeName}${acc}, please? Our customers are waiting on them.`,
    '',
    g.lines
      .map((l, i) =>
        [
          `${i + 1}. ${l.product}${l.quantity > 1 ? ` x ${l.quantity}` : ''}`,
          `   Your ref: ${l.supplierReference || 'not given'} · our ref ${l.orderNumber}`,
          `   ${l.placedAt ? `Ordered ${fmt(l.placedAt.toISOString().slice(0, 10))}` : ''}${l.etaDate ? `${l.placedAt ? ' · ' : ''}expected ${fmt(l.etaDate)}` : ''}`.trimEnd(),
        ]
          .filter((x) => x.trim())
          .join('\n'),
      )
      .join('\n\n'),
    '',
    'A new expected date for each would be great.',
    '',
    'Thanks,',
    sender,
    [org.storeName, org.storePhone].filter(Boolean).join(' · '),
  ].join('\n');
  return { to: g.account?.ordersEmail || g.account?.repEmail || '', subject, body };
}

/**
 * Marks a supplier's lines as placed: whole orders move to Placed; items on multi-item orders move
 * to Ordered, and the order itself moves to Placed once none of its items are still to order.
 * The customer isn't emailed (they were told when the order was taken).
 */
export async function markSupplierPlaced(ctx: Ctx, org: Organisation, key: string, opts: { supplierReference: string; etaDate: string }) {
  if (opts.etaDate && !/^\d{4}-\d{2}-\d{2}$/.test(opts.etaDate)) throw new ServiceError('Use a valid date.', { etaDate: 'Use a valid date' });
  if (opts.etaDate && opts.etaDate < addDays(todayInTz(org.timezone), -1)) throw new ServiceError('The expected date is in the past.', { etaDate: 'In the past' });
  const sheets = await supplierSheets(org);
  const g = sheets.toOrder.find((x) => x.key === key);
  if (!g) throw new ServiceError('Nothing left to order from this supplier — it may already have been placed.');
  const touched = new Set<string>();
  for (const l of g.lines) {
    if (l.itemIndex === null) {
      await quickMove(ctx, l.orderId, 'ordered', { supplierReference: opts.supplierReference, etaDate: opts.etaDate || undefined });
    } else {
      await updateOrderItem(ctx, l.orderId, l.itemIndex, { status: 'ordered', etaDate: opts.etaDate, supplierReference: opts.supplierReference });
      touched.add(l.orderId);
    }
  }
  // Multi-item orders: move the order on once every item has been ordered.
  if (touched.size) {
    const rows = await withTenant(org.id, (tx) =>
      tx.select({ id: orders.id, status: orders.status, spec: orders.specificationJson }).from(orders).where(inArray(orders.id, [...touched])),
    );
    for (const r of rows) {
      const items = asItemsSpec(r.spec);
      if (r.status === 'place_order' && items && items.items.every((it) => itemStatus(it) !== 'to_order')) {
        await quickMove(ctx, r.id, 'ordered', { etaDate: opts.etaDate || undefined });
      }
    }
  }
  return { supplier: g.supplier, lines: g.lines.length };
}
