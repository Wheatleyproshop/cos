import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { bankStatements, bankTransactions, payRuns, payslips, salesHistory, shopSales, type FinanceSettings } from '@/db/schema';
import { recordEvent } from '../../audit';
import { HistoryCsvError, parseSalesHistory } from '../../sales-history-csv';
import { ServiceError, type Ctx } from '../common';
import { accountingYear } from './tax';

/**
 * Year at a glance: each month of the company year beside the same month a year earlier — sales,
 * money in and out, stock bought, wages and running costs — plus brand comparisons. Sales are shown
 * the way Shopify reports them (store credit counted as a discount), so uploaded history and live
 * sales compare like for like.
 */

export async function importSalesHistory(ctx: Ctx, file: File, year?: number) {
  if (file.size > 10 * 1024 * 1024) throw new ServiceError('That file is too big (10 MB maximum).');
  let rows;
  try {
    rows = parseSalesHistory(await file.text(), { year });
  } catch (e) {
    if (e instanceof HistoryCsvError) throw new ServiceError(e.message);
    throw e;
  }
  await withTenant(ctx.org.id, async (tx) => {
    for (let i = 0; i < rows.length; i += 300) {
      await tx
        .insert(salesHistory)
        .values(rows.slice(i, i + 300).map((r) => ({ organisationId: ctx.org.id, ...r, fileName: file.name.slice(0, 120) })))
        .onConflictDoUpdate({
          target: [salesHistory.organisationId, salesHistory.month, salesHistory.months, salesHistory.dimension, salesHistory.name],
          set: { salesPence: sql`excluded.sales_pence`, discountPence: sql`excluded.discount_pence`, quantity: sql`excluded.quantity`, orders: sql`excluded.orders`, fileName: sql`excluded.file_name` },
        });
    }
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'stock_uploaded', entityType: 'organisation', entityId: ctx.org.id,
      metadata: { kind: 'sales_history', file: file.name, rows: rows.length },
    });
  });
  const months = [...new Set(rows.map((r) => r.month))].sort();
  return { rows: rows.length, dimension: rows[0].dimension, from: months[0], to: months[months.length - 1] };
}

const ym = (d: string) => d.slice(0, 7);
const shiftYear = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;
const monthStarts = (start: string) =>
  Array.from({ length: 12 }, (_, i) => {
    const [y, m] = start.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
  });

type MonthFigures = { sales: number | null; salesSource: 'history' | 'shopify' | 'partial' | null; moneyIn: number | null; moneyOut: number | null; stock: number | null; wages: number | null; running: number | null };
const RUNNING = ['Rent & rates', 'Utilities', 'Insurance', 'Software & subscriptions', 'Marketing & advertising', 'Bank & card fees', 'Vehicle & travel', 'Repairs & equipment', 'Other spending'];

async function monthly(orgId: string, from: string, to: string) {
  return withTenant(orgId, async (tx) => {
    const hist = await tx
      .select()
      .from(salesHistory)
      .where(and(eq(salesHistory.dimension, 'total'), eq(salesHistory.months, 1), gte(salesHistory.month, from), lt(salesHistory.month, to)));
    const live = await tx
      .select({ m: sql<string>`to_char(${shopSales.soldOn}, 'YYYY-MM')`, sales: sql<number>`coalesce(sum(${shopSales.unitPricePence} * ${shopSales.quantity} - ${shopSales.discountPence}), 0)::bigint`, first: sql<string>`min(${shopSales.soldOn})::text` })
      .from(shopSales)
      .where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to), sql`${shopSales.quantity} > 0`))
      .groupBy(sql`1`);
    const bank = await tx
      .select({ m: sql<string>`to_char(${bankTransactions.date}, 'YYYY-MM')`, category: bankTransactions.category, inP: sql<number>`coalesce(sum(greatest(${bankTransactions.amountPence}, 0)), 0)::bigint`, outP: sql<number>`coalesce(sum(greatest(-${bankTransactions.amountPence}, 0)), 0)::bigint` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(and(isNull(bankStatements.removedAt), gte(bankTransactions.date, from), lt(bankTransactions.date, to)))
      .groupBy(sql`1`, bankTransactions.category);
    const pay = await tx
      .select({ m: sql<string>`to_char(${payRuns.payDate}, 'YYYY-MM')`, cost: sql<number>`coalesce(sum(${payslips.basicPence} + ${payslips.holidayPayPence} + ${payslips.bonusPence} + ${payslips.employerNiPence} + ${payslips.employerPensionPence}), 0)::bigint` })
      .from(payslips)
      .innerJoin(payRuns, eq(payRuns.id, payslips.payRunId))
      .where(and(gte(payRuns.payDate, from), lt(payRuns.payDate, to)))
      .groupBy(sql`1`);
    const out = new Map<string, MonthFigures>();
    for (const start of monthStarts(from)) {
      const k = ym(start);
      const h = hist.find((x) => ym(x.month) === k);
      const l = live.find((x) => x.m === k);
      const rows = bank.filter((b) => b.m === k);
      const sum = (cats: string[] | null, dir: 'inP' | 'outP') =>
        rows.filter((b) => b.category !== 'Transfers between accounts' && (!cats || cats.includes(b.category))).reduce((n, b) => n + Number(b[dir]), 0);
      const p = pay.find((x) => x.m === k);
      out.set(k, {
        sales: h ? h.salesPence : l ? Number(l.sales) : null,
        salesSource: h ? 'history' : l ? (l.first > `${k}-01` ? 'partial' : 'shopify') : null,
        moneyIn: rows.length ? sum(null, 'inP') : null,
        moneyOut: rows.length ? sum(null, 'outP') : null,
        stock: rows.length ? sum(['Stock & suppliers'], 'outP') : null,
        wages: p ? Number(p.cost) : rows.length ? sum(['Wages'], 'outP') : null,
        running: rows.length ? sum(RUNNING, 'outP') : null,
      });
    }
    return out;
  });
}

async function brandsBetween(orgId: string, from: string, to: string) {
  return withTenant(orgId, async (tx) => {
    const live = await tx
      .select({ brand: shopSales.brand, sales: sql<number>`coalesce(sum(${shopSales.unitPricePence} * ${shopSales.quantity} - ${shopSales.discountPence}), 0)::bigint`, first: sql<string>`min(${shopSales.soldOn})::text` })
      .from(shopSales)
      .where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to), sql`${shopSales.quantity} > 0`))
      .groupBy(shopSales.brand);
    const hist = await tx.select().from(salesHistory).where(and(eq(salesHistory.dimension, 'brand'), gte(salesHistory.month, from), lt(salesHistory.month, to)));
    const m = new Map<string, { name: string; sales: number; source: string }>();
    // History first (it covers whole periods); live Shopify sales only for brands/months not in history.
    for (const h of hist) {
      const k = h.name.toLowerCase();
      const g = m.get(k) ?? { name: h.name, sales: 0, source: 'history' };
      g.sales += h.salesPence;
      m.set(k, g);
    }
    const histHasYear = hist.length > 0;
    if (!histHasYear) {
      for (const l of live) {
        const k = (l.brand || 'Unknown').toLowerCase();
        const g = m.get(k) ?? { name: l.brand || 'Unknown', sales: 0, source: 'shopify' };
        g.sales += Number(l.sales);
        m.set(k, g);
      }
    }
    return { brands: m, source: histHasYear ? 'history' : live.length ? 'shopify' : 'none', liveFrom: live.reduce<string | null>((a, l) => (!a || l.first < a ? l.first : a), null) };
  });
}

export async function yearAtAGlance(orgId: string, fin: Required<FinanceSettings>, today: string, offset = 0) {
  const base = accountingYear(today, fin.yearEndMonth);
  const year = { start: shiftYear(base.start, offset), end: shiftYear(base.end, offset) };
  const prev = { start: shiftYear(year.start, -1), end: shiftYear(year.end, -1) };
  const [cur, last, bThis, bLast] = await Promise.all([
    monthly(orgId, year.start, year.end),
    monthly(orgId, prev.start, prev.end),
    brandsBetween(orgId, year.start, year.end),
    brandsBetween(orgId, prev.start, prev.end),
  ]);
  const months = monthStarts(year.start).map((m) => {
    const k = ym(m);
    const lk = ym(shiftYear(m, -1));
    return { month: m, label: new Date(`${m}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' }), future: m > today, ...withPrev(cur.get(k)!, last.get(lk)!) };
  });
  // Year to date, compared only for months that have figures in both years.
  const keys = ['sales', 'moneyIn', 'moneyOut', 'stock', 'wages', 'running'] as const;
  const ytd = Object.fromEntries(
    keys.map((key) => {
      const both = months.filter((m) => !m.future && m[key].now !== null && m[key].prev !== null);
      const now = months.filter((m) => !m.future && m[key].now !== null).reduce((n, m) => n + (m[key].now ?? 0), 0);
      const nowLike = both.reduce((n, m) => n + (m[key].now ?? 0), 0);
      const prevLike = both.reduce((n, m) => n + (m[key].prev ?? 0), 0);
      return [key, { now, compareMonths: both.length, change: prevLike ? Math.round(((nowLike - prevLike) / prevLike) * 100) : null }];
    }),
  ) as Record<(typeof keys)[number], { now: number; compareMonths: number; change: number | null }>;
  const brandRows = [...new Set([...bThis.brands.keys(), ...bLast.brands.keys()])]
    .map((k) => {
      const now = bThis.brands.get(k);
      const was = bLast.brands.get(k);
      return { name: now?.name ?? was?.name ?? k, now: now?.sales ?? 0, prev: was?.sales ?? null };
    })
    .sort((a, b) => b.now - a.now || (b.prev ?? 0) - (a.prev ?? 0))
    .slice(0, 30);
  return {
    year, prev, label: `${fmtMonth(year.start)} – ${fmtMonth(shiftMonth(year.end, -1))}`, prevLabel: `${fmtMonth(prev.start)} – ${fmtMonth(shiftMonth(prev.end, -1))}`,
    months, ytd, brands: { rows: brandRows, thisSource: bThis.source, lastSource: bLast.source, liveFrom: bThis.liveFrom },
  };
}

function withPrev(now: MonthFigures, prev: MonthFigures) {
  const pair = (a: number | null, b: number | null) => ({ now: a, prev: b, change: a !== null && b ? Math.round(((a - b) / b) * 100) : null });
  return {
    salesSource: now.salesSource,
    sales: pair(now.sales, prev.sales), moneyIn: pair(now.moneyIn, prev.moneyIn), moneyOut: pair(now.moneyOut, prev.moneyOut),
    stock: pair(now.stock, prev.stock), wages: pair(now.wages, prev.wages), running: pair(now.running, prev.running),
  };
}
const shiftMonth = (d: string, n: number) => {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const fmtMonth = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

export async function historySummary(orgId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ dimension: salesHistory.dimension, from: sql<string>`min(${salesHistory.month})::text`, to: sql<string>`max(${salesHistory.month})::text`, n: sql<number>`count(*)::int` })
      .from(salesHistory)
      .groupBy(salesHistory.dimension),
  );
}
