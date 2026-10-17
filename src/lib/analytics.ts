import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { auditEvents, orders, prebookLines, prebooks, quotes, users, workshopItems, workshopJobs, type Organisation } from '@/db/schema';
import { asBallPrintSpec } from './ball-print';
import { fitSpec } from './fit-spec';
import { CLUB_CATEGORIES } from './fitting-rules';

/**
 * Ordering performance for the Overview: sales, trends, best sellers and how quickly each
 * manufacturer turns orders around. Computed from the shop's own orders, quotes and audit trail.
 */

export const PERIODS = [
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '12m', label: '12 months', days: 365 },
  { key: 'all', label: 'All time', days: null },
] as const;
export type PeriodKey = (typeof PERIODS)[number]['key'];

export function parsePeriod(v: string | undefined): PeriodKey {
  return PERIODS.some((p) => p.key === v) ? (v as PeriodKey) : '90d';
}

type Item = { brand: string; product: string; category: string; valuePence: number; qty: number };
export type Ranked = { name: string; valuePence: number; count: number };
export type Turnaround = {
  brand: string; orders: number; avgDays: number; minDays: number; maxDays: number; medianDays: number;
  supplierAvgDays: number | null; delayedPct: number;
};
export type Bucket = { label: string; start: Date; valuePence: number; count: number };
export type ArrivalBrand = { brand: string; items: number; valuePence: number; onTimePct: number | null; avgDaysLate: number | null };
export type Arrivals = {
  receivedItems: number;
  receivedValuePence: number;
  onTimePct: number | null;
  byBrand: ArrivalBrand[];
  outstandingItems: number;
  outstandingValuePence: number;
  overdueLines: number;
  upcoming: { month: string; label: string; items: number; valuePence: number }[];
};

export type WorkshopPerf = {
  checkedIn: number;
  clubs: number;
  valuePence: number;
  finished: number;
  avgTurnaroundDays: number | null;
  onTimePct: number | null;
  waitedForPartsPct: number | null;
  byWork: Ranked[];
  byStaff: Ranked[];
  openNow: number;
  overdueNow: number;
  readyUncollectedNow: number;
  readyValueNow: number;
};

/**
 * Workshop jobs checked in during the period (clubs, value, work types, who took them), jobs
 * finished in the period (turnaround, on time against the date first promised, parts delays),
 * and what's in the workshop now.
 */
async function workshopPerformance(orgId: string, from: Date, end: Date, inclusiveEnd: boolean, tz: string, now: Date): Promise<WorkshopPerf> {
  return withTenant(orgId, async (tx) => {
    const jobs = await tx.select().from(workshopJobs).where(isNull(workshopJobs.archivedAt));
    const items = await tx.select().from(workshopItems).where(isNull(workshopItems.removedAt));
    const staffRows = await tx.select({ id: users.id, name: users.name }).from(users);
    const events = await tx
      .select({ entityId: auditEvents.entityId, eventType: auditEvents.eventType, newValueJson: auditEvents.newValueJson })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'workshop_job'), inArray(auditEvents.eventType, ['workshop_job_created', 'workshop_status_changed'])));
    const inWindow = (d: Date | null) => Boolean(d && d >= from && (inclusiveEnd ? d <= end : d < end));
    const itemsByJob = new Map<string, typeof items>();
    for (const i of items) itemsByJob.set(i.jobId, [...(itemsByJob.get(i.jobId) ?? []), i]);
    const promised = new Map<string, string | null>();
    const waited = new Set<string>();
    for (const e of events) {
      if (!e.entityId) continue;
      const n = (e.newValueJson ?? {}) as { etaDate?: string | null; status?: string };
      if (e.eventType === 'workshop_job_created') promised.set(e.entityId, n.etaDate ?? null);
      if (e.eventType === 'workshop_status_changed' && n.status === 'waiting_parts') waited.add(e.entityId);
    }

    const checkedIn = jobs.filter((j) => j.status !== 'cancelled' && inWindow(j.createdAt));
    const lines = checkedIn.flatMap((j) => itemsByJob.get(j.id) ?? []);
    const names = new Map(staffRows.map((u) => [u.id, u.name]));
    const byWork = rank(lines.map((i) => ({ name: i.work, valuePence: i.pricePence, qty: i.quantity })), 12);
    const byStaff = rank(
      checkedIn.map((j) => ({ name: names.get(j.takenByUserId) ?? 'Unknown', valuePence: (itemsByJob.get(j.id) ?? []).reduce((s, i) => s + i.pricePence, 0), qty: 1 })),
      10,
    );

    const finished = jobs.filter((j) => inWindow(j.readyAt));
    const turn = finished.map((j) => days(j.createdAt, j.readyAt!));
    const dated = finished.filter((j) => promised.get(j.id) ?? j.etaDate);
    const onTime = dated.filter((j) => j.readyAt!.toLocaleDateString('en-CA', { timeZone: tz }) <= (promised.get(j.id) ?? j.etaDate)!);

    const today = now.toLocaleDateString('en-CA', { timeZone: tz });
    const open = jobs.filter((j) => ['checked_in', 'in_progress', 'waiting_parts'].includes(j.status));
    const ready = jobs.filter((j) => j.status === 'ready');
    return {
      checkedIn: checkedIn.length,
      clubs: lines.reduce((s, i) => s + i.quantity, 0),
      valuePence: lines.reduce((s, i) => s + i.pricePence, 0),
      finished: finished.length,
      avgTurnaroundDays: turn.length ? round1(turn.reduce((s, x) => s + x, 0) / turn.length) : null,
      onTimePct: dated.length ? Math.round((onTime.length / dated.length) * 100) : null,
      waitedForPartsPct: finished.length ? Math.round((finished.filter((j) => waited.has(j.id)).length / finished.length) * 100) : null,
      byWork,
      byStaff,
      openNow: open.length,
      overdueNow: open.filter((j) => j.etaDate && j.etaDate < today).length,
      readyUncollectedNow: ready.length,
      readyValueNow: ready.reduce((s, j) => s + (itemsByJob.get(j.id) ?? []).reduce((t, i) => t + i.pricePence, 0), 0),
    };
  });
}

type ReceivedChange = { lineId?: string; from: number; to: number; unitCostPence?: number; expected?: string | null };

/**
 * Pre-book stock booked in during the period (valued at trade cost and checked against each line's
 * expected date), plus what is still to arrive as of now.
 */
async function prebookArrivals(orgId: string, from: Date, end: Date, inclusiveEnd: boolean, tz: string, now: Date): Promise<Arrivals> {
  return withTenant(orgId, async (tx) => {
    const events = await tx
      .select({ createdAt: auditEvents.createdAt, newValueJson: auditEvents.newValueJson, brand: prebooks.brand, prebookId: prebooks.id, p: prebooks })
      .from(auditEvents)
      .innerJoin(prebooks, eq(prebooks.id, auditEvents.entityId))
      .where(
        and(
          eq(auditEvents.eventType, 'prebook_received'),
          gte(auditEvents.createdAt, from),
          inclusiveEnd ? sql`${auditEvents.createdAt} <= ${end}` : lt(auditEvents.createdAt, end),
        ),
      );
    // Older booking-in entries didn't record the line, cost or due date: look the line up by id or by name.
    const allLines = await tx.select().from(prebookLines);
    const byId = new Map(allLines.map((l) => [l.id, l]));
    const byName = new Map(allLines.map((l) => [`${l.prebookId}|${[l.product, l.variant].filter(Boolean).join(' — ')}`, l]));
    const byBrand = new Map<string, { brand: string; items: number; value: number; onTime: number; dated: number; lateDays: number[] }>();
    for (const e of events) {
      const day = e.createdAt.toLocaleDateString('en-CA', { timeZone: tz });
      for (const c of ((e.newValueJson as { lines?: (ReceivedChange & { product?: string })[] } | null)?.lines ?? [])) {
        const qty = c.to - c.from;
        if (qty <= 0) continue;
        const line = (c.lineId && byId.get(c.lineId)) || byName.get(`${e.prebookId}|${c.product ?? ''}`);
        const expected = c.expected !== undefined ? c.expected : line ? (line.expectedDate ?? e.p.expectedTo ?? e.p.expectedFrom) : null;
        const key = e.brand.trim().toLowerCase();
        const g = byBrand.get(key) ?? { brand: e.brand.trim(), items: 0, value: 0, onTime: 0, dated: 0, lateDays: [] };
        g.items += qty;
        g.value += qty * (c.unitCostPence ?? line?.unitCostPence ?? 0);
        if (expected) {
          g.dated += qty;
          if (day <= expected) g.onTime += qty;
          else g.lateDays.push(days(new Date(`${expected}T12:00:00Z`), new Date(`${day}T12:00:00Z`)));
        }
        byBrand.set(key, g);
      }
    }
    const brandsOut: ArrivalBrand[] = [...byBrand.values()]
      .map((g) => ({
        brand: g.brand, items: g.items, valuePence: g.value,
        onTimePct: g.dated ? Math.round((g.onTime / g.dated) * 100) : null,
        avgDaysLate: g.lateDays.length ? round1(g.lateDays.reduce((s, x) => s + x, 0) / g.lateDays.length) : null,
      }))
      .sort((a, b) => b.valuePence - a.valuePence);
    const dated = [...byBrand.values()].reduce((s, g) => s + g.dated, 0);
    const onTime = [...byBrand.values()].reduce((s, g) => s + g.onTime, 0);

    const open = await tx
      .select({ line: prebookLines, prebook: prebooks })
      .from(prebookLines)
      .innerJoin(prebooks, eq(prebooks.id, prebookLines.prebookId))
      .where(
        and(
          isNull(prebookLines.removedAt), isNull(prebooks.archivedAt),
          sql`${prebooks.status} not in ('draft', 'cancelled', 'delivered')`,
          sql`${prebookLines.quantityReceived} < ${prebookLines.quantity}`,
        ),
      );
    const today = now.toLocaleDateString('en-CA', { timeZone: tz });
    const months = new Map<string, { items: number; valuePence: number }>();
    let overdueLines = 0;
    for (const { line, prebook } of open) {
      const left = line.quantity - line.quantityReceived;
      const when = line.expectedDate ?? prebook.expectedFrom ?? prebook.expectedTo;
      const by = line.expectedDate ?? prebook.expectedTo ?? prebook.expectedFrom;
      if (by && by < today) overdueLines += 1;
      const key = when ? when.slice(0, 7) : 'unscheduled';
      const m = months.get(key) ?? { items: 0, valuePence: 0 };
      m.items += left;
      m.valuePence += left * line.unitCostPence;
      months.set(key, m);
    }
    const upcoming = [...months.entries()]
      .sort(([a], [b]) => (a === 'unscheduled' ? 1 : b === 'unscheduled' ? -1 : a.localeCompare(b)))
      .map(([month, m]) => ({
        month,
        label: month === 'unscheduled' ? 'No date yet' : new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        ...m,
      }));

    return {
      receivedItems: brandsOut.reduce((s, b) => s + b.items, 0),
      receivedValuePence: brandsOut.reduce((s, b) => s + b.valuePence, 0),
      onTimePct: dated ? Math.round((onTime / dated) * 100) : null,
      byBrand: brandsOut,
      outstandingItems: upcoming.reduce((s, m) => s + m.items, 0),
      outstandingValuePence: upcoming.reduce((s, m) => s + m.valuePence, 0),
      overdueLines,
      upcoming,
    };
  });
}

const DAY = 86_400_000;
const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;
const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Groups names case-insensitively ("TITLEIST" and "Titleist"), keeping the most common spelling. */
function rank(items: { name: string; valuePence: number; qty: number }[], limit = 8): Ranked[] {
  const groups = new Map<string, { names: Map<string, number>; valuePence: number; count: number }>();
  for (const it of items) {
    const key = it.name.trim().toLowerCase();
    if (!key) continue;
    const g = groups.get(key) ?? { names: new Map(), valuePence: 0, count: 0 };
    g.names.set(it.name.trim(), (g.names.get(it.name.trim()) ?? 0) + 1);
    g.valuePence += it.valuePence;
    g.count += it.qty;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ name: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0], valuePence: g.valuePence, count: g.count }))
    .sort((a, b) => b.valuePence - a.valuePence || b.count - a.count)
    .slice(0, limit);
}

/** What was actually sold on an order: each fitted club, a ball print job, or the order itself. */
function itemsOf(o: { brand: string; product: string; totalGrossPence: number; specificationJson: unknown }): Item[] {
  const fit = fitSpec(o.specificationJson);
  if (fit) {
    return fit.builds.map((b) => {
      const brand = b.brand || (o.brand.includes('/') ? b.title.split(' ')[0] : o.brand);
      return {
        brand,
        product: b.title.startsWith(brand) ? b.title.slice(brand.length).trim() || b.title : b.title,
        category: CLUB_CATEGORIES.find((c) => c.key === b.category)?.label ?? 'Clubs',
        valuePence: b.totalPence,
        qty: 1,
      };
    });
  }
  const ball = asBallPrintSpec(o.specificationJson);
  if (ball) {
    return [{ brand: ball.ball.brand, product: `${ball.ball.name} (printed)`, category: 'Printed balls', valuePence: o.totalGrossPence, qty: 1 }];
  }
  return [{ brand: o.brand, product: o.product, category: guessKind(o.product), valuePence: o.totalGrossPence, qty: 1 }];
}

/** Best guess at what a manually entered order is, from its product name. */
const KINDS: [RegExp, string][] = [
  [/\bdrivers?\b/i, 'Drivers'],
  [/\b(fairway|[3579]\s?-?wood|fw)\b/i, 'Fairways'],
  [/\b(hybrid|rescue|utility wood)\b/i, 'Hybrids'],
  [/\b(irons?|iron set|utility iron)\b/i, 'Irons'],
  [/\bwedges?\b|vokey|\bsm1\d\b/i, 'Wedges'],
  [/\bputters?\b|scotty|odyssey|spider/i, 'Putters'],
  [/\bballs?\b|pro ?v1|tp5|chrome (soft|tour)|z-?star/i, 'Balls'],
  [/\bshoes?\b/i, 'Shoes'],
  [/\b(bag|trolley|cart)\b/i, 'Bags & trolleys'],
  [/\b(glove|grip|towel|rangefinder|gps|headcover)s?\b/i, 'Accessories'],
  [/\b(shirt|polo|jacket|jumper|trousers|shorts|cap|hat|waterproof)s?\b/i, 'Clothing'],
];
function guessKind(product: string) {
  return KINDS.find(([re]) => re.test(product))?.[1] ?? 'Other';
}

function orderType(specificationJson: unknown) {
  return fitSpec(specificationJson) ? 'Custom fitting' : asBallPrintSpec(specificationJson) ? 'Ball printing' : 'Standard order';
}

function buckets(period: PeriodKey, from: Date, now: Date, tz: string): Bucket[] {
  const out: Bucket[] = [];
  if (period === '30d' || period === '90d') {
    // Weeks starting Monday
    const start = new Date(from);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    for (let d = start; d <= now; d = new Date(d.getTime() + 7 * DAY)) {
      out.push({ label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz }), start: d, valuePence: 0, count: 0 });
    }
  } else {
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    for (let d = start; d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      out.push({ label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: tz }), start: d, valuePence: 0, count: 0 });
    }
  }
  return out;
}

/** An exact reporting window (e.g. last calendar month), compared with the window before it. */
export type ReportRange = { key: 'month'; label: string; from: Date; to: Date; prevFrom: Date };

export async function getPerformance(org: Organisation, period: PeriodKey | ReportRange, now = new Date()) {
  const range = typeof period === 'string' ? null : period;
  const p: { key: string; label: string; days: number | null } = range
    ? { key: range.key, label: range.label, days: null }
    : PERIODS.find((x) => x.key === period)!;
  const { allOrders, allQuotes, staff, statusEvents } = await withTenant(org.id, async (tx) => {
    const allOrders = await tx
      .select({
        id: orders.id, brand: orders.brand, product: orders.product, totalGrossPence: orders.totalGrossPence, status: orders.status,
        createdAt: orders.createdAt, readyAt: orders.readyAt, specificationJson: orders.specificationJson,
        takenByUserId: orders.takenByUserId, customerId: orders.customerId,
      })
      .from(orders);
    const allQuotes = await tx.select({ status: quotes.status, createdAt: quotes.createdAt, sentAt: quotes.sentAt, acceptedAt: quotes.acceptedAt }).from(quotes);
    const staff = await tx.select({ id: users.id, name: users.name }).from(users);
    const statusEvents = allOrders.length
      ? await tx
          .select({ orderId: auditEvents.orderId, newValueJson: auditEvents.newValueJson, createdAt: auditEvents.createdAt })
          .from(auditEvents)
          .where(and(eq(auditEvents.entityType, 'order'), inArray(auditEvents.eventType, ['status_changed'])))
      : [];
    return { allOrders, allQuotes, staff, statusEvents };
  });

  const first = allOrders.reduce<Date | null>((m, o) => (!m || o.createdAt < m ? o.createdAt : m), null);
  const end = range ? range.to : now;
  const from = range ? range.from : p.days ? new Date(now.getTime() - p.days * DAY) : (first ?? now);
  const inPeriod = <T extends { createdAt: Date }>(r: T) => r.createdAt >= from && (range ? r.createdAt < end : r.createdAt <= end);
  const periodOrders = allOrders.filter(inPeriod);

  // When each order was actually placed with the supplier, and whether it was ever delayed.
  const orderedAt = new Map<string, Date>();
  const delayed = new Set<string>();
  for (const e of statusEvents) {
    if (!e.orderId) continue;
    const status = (e.newValueJson as { status?: string } | null)?.status;
    if (status === 'ordered' && (!orderedAt.has(e.orderId) || e.createdAt < orderedAt.get(e.orderId)!)) orderedAt.set(e.orderId, e.createdAt);
    if (status === 'delayed') delayed.add(e.orderId);
  }

  // Headline figures, compared with the previous period of the same length.
  const value = periodOrders.reduce((s, o) => s + o.totalGrossPence, 0);
  const prevFrom = range ? range.prevFrom : p.days ? new Date(from.getTime() - p.days * DAY) : null;
  const prevOrders = prevFrom ? allOrders.filter((o) => o.createdAt >= prevFrom && o.createdAt < from) : [];
  const prevValue = prevOrders.reduce((s, o) => s + o.totalGrossPence, 0);
  const change = (now: number, before: number) => (!prevFrom || !before ? null : Math.round(((now - before) / before) * 100));
  const periodQuotes = allQuotes.filter(inPeriod).filter((q) => q.status !== 'draft');
  const approved = periodQuotes.filter((q) => q.status === 'accepted');
  const approveDays = approved.filter((q) => q.sentAt && q.acceptedAt).map((q) => days(q.sentAt!, q.acceptedAt!));
  const arrived = allOrders.filter((o) => o.readyAt && o.readyAt >= from && o.readyAt < (range ? end : new Date(end.getTime() + 1)));
  const turnDays = arrived.map((o) => days(o.createdAt, o.readyAt!));
  const ordersByCustomer = new Map<string, number>();
  for (const o of allOrders) ordersByCustomer.set(o.customerId, (ordersByCustomer.get(o.customerId) ?? 0) + 1);
  const periodCustomers = [...new Set(periodOrders.map((o) => o.customerId))];
  const repeat = periodCustomers.filter((c) => (ordersByCustomer.get(c) ?? 0) > 1).length;
  const open = allOrders.filter((o) => o.status !== 'collected');

  // Trend
  const trend = buckets(range ? '30d' : (period as PeriodKey), from, range ? new Date(end.getTime() - 1) : end, org.timezone);
  for (const o of periodOrders) {
    const b = [...trend].reverse().find((x) => x.start <= o.createdAt);
    if (b) {
      b.valuePence += o.totalGrossPence;
      b.count += 1;
    }
  }

  // Best sellers
  const items = periodOrders.flatMap(itemsOf);
  const brands = rank(items.map((i) => ({ name: i.brand, valuePence: i.valuePence, qty: i.qty })));
  const products = rank(items.map((i) => ({ name: `${i.brand} ${i.product}`.trim(), valuePence: i.valuePence, qty: i.qty })));
  const categories = rank(items.map((i) => ({ name: i.category, valuePence: i.valuePence, qty: i.qty })), 10);
  const mix = rank(periodOrders.map((o) => ({ name: orderType(o.specificationJson), valuePence: o.totalGrossPence, qty: 1 })), 5);
  const staffNames = new Map(staff.map((u) => [u.id, u.name]));
  const team = rank(periodOrders.map((o) => ({ name: staffNames.get(o.takenByUserId) ?? 'Unknown', valuePence: o.totalGrossPence, qty: 1 })), 10);

  // Manufacturer turnaround: order taken → arrived in store, per brand on the order.
  const perBrand = new Map<string, { name: string; days: number[]; supplier: number[]; delayed: number }>();
  for (const o of arrived) {
    const d = days(o.createdAt, o.readyAt!);
    const placed = orderedAt.get(o.id);
    const brandNames = [...new Set(itemsOf(o).map((i) => i.brand.trim()))];
    for (const name of brandNames) {
      const key = name.toLowerCase();
      const g = perBrand.get(key) ?? { name, days: [], supplier: [], delayed: 0 };
      g.days.push(d);
      if (placed && placed < o.readyAt!) g.supplier.push(days(placed, o.readyAt!));
      if (delayed.has(o.id)) g.delayed += 1;
      perBrand.set(key, g);
    }
  }
  const turnaround: Turnaround[] = [...perBrand.values()]
    .map((g) => ({
      brand: g.name,
      orders: g.days.length,
      avgDays: round1(g.days.reduce((s, x) => s + x, 0) / g.days.length),
      minDays: round1(Math.min(...g.days)),
      maxDays: round1(Math.max(...g.days)),
      medianDays: round1(median(g.days)),
      supplierAvgDays: g.supplier.length ? round1(g.supplier.reduce((s, x) => s + x, 0) / g.supplier.length) : null,
      delayedPct: Math.round((g.delayed / g.days.length) * 100),
    }))
    .sort((a, b) => b.orders - a.orders || a.avgDays - b.avgDays);

  const [arrivals, workshop] = await Promise.all([
    prebookArrivals(org.id, from, end, !range, org.timezone, now),
    workshopPerformance(org.id, from, end, !range, org.timezone, now),
  ]);

  return {
    period: p,
    from,
    arrivals,
    workshop,
    kpis: {
      valuePence: value,
      valueChange: change(value, prevValue),
      orders: periodOrders.length,
      ordersChange: change(periodOrders.length, prevOrders.length),
      avgOrderPence: periodOrders.length ? Math.round(value / periodOrders.length) : 0,
      quotes: periodQuotes.length,
      quotesApproved: approved.length,
      approvalRate: periodQuotes.length ? Math.round((approved.length / periodQuotes.length) * 100) : null,
      avgApproveDays: approveDays.length ? round1(approveDays.reduce((s, x) => s + x, 0) / approveDays.length) : null,
      avgTurnaroundDays: turnDays.length ? round1(turnDays.reduce((s, x) => s + x, 0) / turnDays.length) : null,
      arrived: arrived.length,
      customers: periodCustomers.length,
      repeatPct: periodCustomers.length ? Math.round((repeat / periodCustomers.length) * 100) : null,
      openValuePence: open.reduce((s, o) => s + o.totalGrossPence, 0),
      openOrders: open.length,
    },
    trend,
    brands,
    products,
    categories,
    mix,
    team,
    turnaround,
  };
}

export type Performance = Awaited<ReturnType<typeof getPerformance>>;
