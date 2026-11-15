import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { bankStatements, bankTransactions, organisations, payRuns, payslips, shopSales, stockCatalogue, type FinanceSettings } from '@/db/schema';
import { recordEvent } from '../../audit';
import { ServiceError, type Ctx } from '../common';

/**
 * Tax planning estimates (not a return): VAT due for each quarter and the year's corporation tax,
 * worked out from Shopify sales (credit vouchers counted as money, as HMRC treats trade-in credit),
 * cost of goods sold, bank statements and pay runs. Rates: UK 2026/27.
 */

const VAT_RATE = 0.2;
export const CT = { small: 0.19, main: 0.25, lower: 50_000_00, upper: 250_000_00, reliefFraction: 3 / 200 };

/** UK corporation tax on a year's taxable profit (pence), with marginal relief between £50k and £250k. */
export function corporationTax(profitPence: number) {
  if (profitPence <= 0) return 0;
  if (profitPence <= CT.lower) return Math.round(profitPence * CT.small);
  if (profitPence >= CT.upper) return Math.round(profitPence * CT.main);
  return Math.round(profitPence * CT.main - CT.reliefFraction * (CT.upper - profitPence));
}

export const DEFAULT_FINANCE: Required<FinanceSettings> = { vatRegistered: true, vatStagger: 1, vatScheme: 'standard', flatRatePct: 0, yearEndMonth: 12, limitedCompany: true };
export const financeSettings = (f: FinanceSettings | null | undefined): Required<FinanceSettings> => ({ ...DEFAULT_FINANCE, ...(f ?? {}) });

const iso = (y: number, m0: number, d = 1) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
export const STAGGER_ENDS: Record<1 | 2 | 3, number[]> = { 1: [3, 6, 9, 12], 2: [4, 7, 10, 1], 3: [5, 8, 11, 2] };

/** The VAT quarter [start, end) containing `date`, for a stagger. */
export function vatQuarter(date: string, stagger: 1 | 2 | 3, offset = 0) {
  const [y, m] = date.split('-').map(Number);
  let abs = y * 12 + (m - 1);
  while (!STAGGER_ENDS[stagger].includes((abs % 12) + 1)) abs++;
  abs += offset * 3;
  const endY = Math.floor(abs / 12);
  const endM = abs % 12;
  const start = iso(endY, endM - 2);
  const end = iso(endY, endM + 1);
  // Due: one calendar month and seven days after the last day of the quarter.
  const due = addDays(iso(endY, endM + 2), 6);
  return { start, end, due, label: `${new Date(`${start}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' })}–${new Date(`${addDays(end, -1)}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` };
}

/** The accounting year [start, end) containing `date`, ending with `yearEndMonth`. */
export function accountingYear(date: string, yearEndMonth: number) {
  const [y, m] = date.split('-').map(Number);
  const endY = m > yearEndMonth ? y + 1 : y;
  const end = iso(endY, yearEndMonth); // first day after the year end month
  const start = iso(endY - 1, yearEndMonth);
  return { start, end, due: addDays(iso(endY, yearEndMonth + 9), 0), label: `year to ${new Date(`${addDays(end, -1)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` };
}

type Money = { salesInclVat: number; cogs: number; costedExVat: number; days: number; from: string; to: string };

async function salesBetween(orgId: string, from: string, to: string): Promise<Money> {
  return withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ v: organisations.voucherDiscounts }).from(organisations).limit(1);
    const vouchers = new Set((org?.v ?? []).map((x) => x.toLowerCase()));
    const rows = await tx.select().from(shopSales).where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to)));
    const keys = [...new Set(rows.map((r) => r.key).filter(Boolean))];
    const costs = keys.length ? await tx.select({ key: stockCatalogue.key, cost: stockCatalogue.costPence }).from(stockCatalogue) : [];
    const cost = new Map(costs.map((c) => [c.key, c.cost]));
    let salesInclVat = 0;
    let cogs = 0;
    let costedExVat = 0;
    for (const r of rows) {
      if (r.quantity <= 0) continue;
      const credit = r.discounts.filter((d) => vouchers.has(d.name.toLowerCase())).reduce((n, d) => n + d.pence, 0);
      const sold = r.unitPricePence * r.quantity - (r.discountPence - credit);
      salesInclVat += sold;
      const c = cost.get(r.key);
      if (c) {
        cogs += c * r.quantity;
        costedExVat += sold / (1 + VAT_RATE);
      }
    }
    return { salesInclVat, cogs, costedExVat, days: daysBetween(from, to), from, to };
  });
}

/** Earliest Shopify sale COS holds, and the range covered by uploaded bank statements. */
async function coverage(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const [s] = await tx.select({ first: sql<string | null>`min(${shopSales.soldOn})::text`, last: sql<string | null>`max(${shopSales.soldOn})::text` }).from(shopSales);
    const [b] = await tx
      .select({ first: sql<string | null>`min(${bankTransactions.date})::text`, last: sql<string | null>`max(${bankTransactions.date})::text` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(isNull(bankStatements.removedAt));
    return { salesFirst: s?.first ?? null, salesLast: s?.last ?? null, bankFirst: b?.first ?? null, bankLast: b?.last ?? null };
  });
}

/** Spending from bank statements by category in [from, to): money out, positive pence. */
async function bankOut(orgId: string, from: string, to: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ category: bankTransactions.category, out: sql<number>`coalesce(sum(case when ${bankTransactions.amountPence} < 0 then -${bankTransactions.amountPence} else 0 end), 0)::bigint` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(and(isNull(bankStatements.removedAt), gte(bankTransactions.date, from), lt(bankTransactions.date, to)))
      .groupBy(bankTransactions.category),
  );
  return new Map(rows.map((r) => [r.category, Number(r.out)]));
}

/** Spending that usually carries 20% VAT you can reclaim. */
const VATABLE = ['Stock & suppliers', 'Utilities', 'Software & subscriptions', 'Marketing & advertising', 'Repairs & equipment', 'Vehicle & travel'];
/** Running costs for profit (VAT-able ones are taken net of VAT). Stock is counted as cost of goods sold instead. */
const OVERHEADS: [string, boolean][] = [
  ['Rent & rates', false], ['Utilities', true], ['Insurance', false], ['Software & subscriptions', true], ['Marketing & advertising', true],
  ['Bank & card fees', false], ['Vehicle & travel', true], ['Repairs & equipment', true], ['Other spending', false], ['Loans & finance', false],
];

export async function vatForecast(orgId: string, settings: Required<FinanceSettings>, today: string) {
  const cov = await coverage(orgId);
  const quarters = [-1, 0, 1].map((o) => vatQuarter(today, settings.vatStagger, o));
  const tomorrow = addDays(today, 1);
  const out = [];
  for (const q of quarters) {
    const future = q.start > today;
    const until = q.end < tomorrow ? q.end : tomorrow;
    const dataFrom = cov.salesFirst && cov.salesFirst > q.start ? cov.salesFirst : q.start;
    // The rate of sale: this quarter's own if there's some, else the last 30 days.
    const basis = !future && dataFrom < until ? await salesBetween(orgId, dataFrom, until) : await salesBetween(orgId, addDays(today, -30), tomorrow);
    const perDay = basis.days > 0 ? basis.salesInclVat / basis.days : 0;
    const qDays = daysBetween(q.start, q.end);
    const actual = !future && dataFrom < until ? basis.salesInclVat : 0;
    const estimatedDays = qDays - (!future && dataFrom < until ? basis.days : 0);
    const sales = actual + perDay * estimatedDays;
    const share = estimatedDays / qDays;
    let outputVat = sales * (VAT_RATE / (1 + VAT_RATE));
    let inputVat = 0;
    let inputFrom: 'bank' | 'estimate' | 'none' = 'none';
    if (settings.vatScheme === 'flat') {
      outputVat = sales * (settings.flatRatePct / 100);
    } else if (cov.bankFirst && cov.bankFirst <= addDays(q.start, 7) && cov.bankLast && cov.bankLast >= addDays(until, -10) && !future) {
      const spend = await bankOut(orgId, q.start, until);
      const vatable = VATABLE.reduce((n, c) => n + (spend.get(c) ?? 0), 0);
      const soFarDays = daysBetween(q.start, until);
      inputVat = (vatable * (qDays / Math.max(1, soFarDays)) * VAT_RATE) / (1 + VAT_RATE);
      inputFrom = 'bank';
    } else {
      // Assume stock is replaced as it sells: purchases ≈ cost of goods sold, plus 20% VAT.
      const ratio = basis.costedExVat > 0 ? basis.cogs / basis.costedExVat : 0.6;
      inputVat = (sales / (1 + VAT_RATE)) * ratio * VAT_RATE;
      inputFrom = 'estimate';
    }
    out.push({
      ...q, current: q.start <= today && today < q.end, future, salesInclVat: Math.round(sales), estimatedShare: Math.round(share * 100),
      outputVat: Math.round(outputVat), inputVat: Math.round(inputVat), payable: Math.round(outputVat - inputVat), inputFrom,
    });
  }
  return { quarters: out, coverage: cov };
}

export async function corporationTaxForecast(orgId: string, settings: Required<FinanceSettings>, today: string) {
  const cov = await coverage(orgId);
  const y = accountingYear(today, settings.yearEndMonth);
  const tomorrow = addDays(today, 1);
  const yearDays = daysBetween(y.start, y.end);
  const from = cov.salesFirst && cov.salesFirst > y.start ? cov.salesFirst : y.start;
  const s = await salesBetween(orgId, from, tomorrow);
  const scale = s.days > 0 ? yearDays / s.days : 0;
  const salesExVat = (s.salesInclVat / (1 + VAT_RATE)) * scale;
  const marginRatio = s.costedExVat > 0 ? 1 - s.cogs / s.costedExVat : null;
  const grossProfit = marginRatio === null ? null : salesExVat * marginRatio;

  // Running costs from bank statements, scaled to a year from the months covered.
  let overheads: number | null = null;
  let wagesFromBank = 0;
  if (cov.bankFirst && cov.bankLast) {
    const bFrom = cov.bankFirst > y.start ? cov.bankFirst : y.start;
    const bTo = addDays(cov.bankLast, 1) < tomorrow ? addDays(cov.bankLast, 1) : tomorrow;
    const bDays = Math.max(1, daysBetween(bFrom, bTo));
    if (bDays >= 28) {
      const spend = await bankOut(orgId, bFrom, bTo);
      const total = OVERHEADS.reduce((n, [c, vatable]) => n + (spend.get(c) ?? 0) / (vatable ? 1 + VAT_RATE : 1), 0);
      overheads = total * (yearDays / bDays);
      wagesFromBank = (spend.get('Wages') ?? 0) * (yearDays / bDays);
    }
  }
  // Staff costs: pay runs in the year (gross + employer NI and pension), else wages seen in the bank.
  const runs = await withTenant(orgId, async (tx) => {
    const rs = await tx.select({ id: payRuns.id, payDate: payRuns.payDate }).from(payRuns).where(and(gte(payRuns.payDate, y.start), lt(payRuns.payDate, tomorrow)));
    if (!rs.length) return { cost: 0, first: null as string | null };
    const slips = await tx
      .select({ c: sql<number>`coalesce(sum(${payslips.basicPence} + ${payslips.holidayPayPence} + ${payslips.bonusPence} + ${payslips.employerNiPence} + ${payslips.employerPensionPence}), 0)::bigint` })
      .from(payslips)
      .where(sql`${payslips.payRunId} in (${sql.join(rs.map((r) => sql`${r.id}`), sql`, `)})`);
    return { cost: Number(slips[0]?.c ?? 0), first: rs.map((r) => r.payDate).sort()[0] };
  });
  const payrollDays = runs.first ? Math.max(28, daysBetween(runs.first, tomorrow)) : 0;
  const staff = runs.cost ? runs.cost * (yearDays / payrollDays) : wagesFromBank;

  const profit = grossProfit === null ? null : grossProfit - (overheads ?? 0) - staff;
  const tax = profit === null ? null : corporationTax(Math.round(profit));
  const elapsed = daysBetween(y.start, tomorrow);
  return {
    ...y, salesExVat: Math.round(salesExVat), grossProfit: grossProfit === null ? null : Math.round(grossProfit), marginPct: marginRatio === null ? null : Math.round(marginRatio * 100),
    overheads: overheads === null ? null : Math.round(overheads), staff: Math.round(staff), staffFrom: runs.cost ? 'payroll' : wagesFromBank ? 'bank' : 'none',
    profit: profit === null ? null : Math.round(profit), tax, perMonth: tax === null ? null : Math.round(tax / 12),
    salesDays: s.days, yearDays, elapsedPct: Math.round((elapsed / yearDays) * 100), coverage: cov,
  };
}

/** Saves the tax planning settings (owner). */
export async function saveFinanceSettings(ctx: Ctx, raw: Record<string, string>) {
  const stagger = Number(raw.vatStagger);
  const ye = Number(raw.yearEndMonth);
  const flat = Number(raw.flatRatePct || 0);
  if (![1, 2, 3].includes(stagger)) throw new ServiceError('Pick your VAT quarters.');
  if (!Number.isInteger(ye) || ye < 1 || ye > 12) throw new ServiceError('Pick your year end month.');
  if (raw.vatScheme === 'flat' && (!(flat > 0) || flat > 20)) throw new ServiceError('Enter your flat rate percentage (e.g. 7.5).', { flatRatePct: 'e.g. 7.5' });
  const next: FinanceSettings = {
    vatRegistered: raw.vatRegistered === 'on', vatStagger: stagger as 1 | 2 | 3, vatScheme: raw.vatScheme === 'flat' ? 'flat' : 'standard',
    flatRatePct: raw.vatScheme === 'flat' ? flat : 0, yearEndMonth: ye, limitedCompany: raw.limitedCompany === 'on',
  };
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ finance: next }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id, oldValue: { finance: ctx.org.finance }, newValue: { finance: next }, metadata: { section: 'finance' } });
  });
}
