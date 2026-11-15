import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import { withTenant } from '@/db';
import { bankStatements, bankTransactions } from '@/db/schema';
import { ruleMatchFor } from '../../bank-csv';

/**
 * Plain-English feedback on the bank figures: what changed, what's a big share, regular payments,
 * what each supplier is being paid. Rules of thumb, not accounting advice.
 */

export type Insight = { tone: 'good' | 'warn' | 'info'; title: string; detail: string };

/** Bank descriptions → the brand(s) a supplier account pays for. */
const SUPPLIERS: [RegExp, string][] = [
  [/acushnet/i, 'Titleist & FootJoy'], [/titleist/i, 'Titleist'], [/footjoy/i, 'FootJoy'], [/callaway|topgolf callaway/i, 'Callaway & Odyssey'],
  [/taylor ?made/i, 'TaylorMade'], [/karsten|\bping\b/i, 'PING'], [/mizuno/i, 'Mizuno'], [/cobra|puma/i, 'Cobra & Puma'],
  [/dunlop|srixon|cleveland/i, 'Srixon & Cleveland'], [/nike/i, 'Nike'], [/under ?armour/i, 'Under Armour'], [/adidas/i, 'adidas'],
  [/hugo boss|\bboss\b/i, 'BOSS'], [/glenmuir/i, 'Glenmuir'], [/lyle ?& ?scott|lyle and scott/i, 'Lyle & Scott'], [/g\/?fore/i, 'G/FORE'],
  [/motocaddy/i, 'Motocaddy'], [/powakaddy/i, 'PowaKaddy'], [/garmin/i, 'Garmin'], [/bushnell/i, 'Bushnell'], [/golf pride|eaton/i, 'Golf Pride'],
  [/superstroke/i, 'SuperStroke'], [/ecco/i, 'ECCO'], [/skechers/i, 'Skechers'], [/travis ?mathew/i, 'TravisMathew'], [/ogio/i, 'OGIO'],
  [/shot ?scope/i, 'Shot Scope'], [/pxg|parsons/i, 'PXG'], [/wilson/i, 'Wilson'], [/bridgestone/i, 'Bridgestone'], [/proquip/i, 'ProQuip'],
  [/galvin green/i, 'Galvin Green'], [/oscar jacobson/i, 'Oscar Jacobson'], [/abacus/i, 'Abacus'], [/spurk/i, 'Spurk'],
];
export const supplierFor = (description: string) => SUPPLIERS.find(([re]) => re.test(description))?.[1] ?? null;

const money = (p: number) => `£${Math.round(p / 100).toLocaleString('en-GB')}`;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

type Tx = { date: string; description: string; amountPence: number; category: string };

async function txsBetween(orgId: string, from: string, to: string): Promise<Tx[]> {
  return withTenant(orgId, (tx) =>
    tx
      .select({ date: bankTransactions.date, description: bankTransactions.description, amountPence: bankTransactions.amountPence, category: bankTransactions.category })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(and(isNull(bankStatements.removedAt), gte(bankTransactions.date, from), lt(bankTransactions.date, to))),
  );
}

const shiftMonths = (iso: string, n: number) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};

/** Feedback for [from, to) compared with the same length of time just before. */
export async function spendingInsights(orgId: string, from: string, to: string, months: number) {
  const prevFrom = shiftMonths(from, -months);
  const yearAgo = shiftMonths(to, -12);
  const [now, before, year] = await Promise.all([txsBetween(orgId, from, to), txsBetween(orgId, prevFrom, from), txsBetween(orgId, yearAgo, to)]);
  const real = (t: Tx) => t.category !== 'Transfers between accounts';
  const out = (rows: Tx[], cat?: string) => rows.filter((t) => t.amountPence < 0 && real(t) && (!cat || t.category === cat)).reduce((n, t) => n - t.amountPence, 0);
  const inn = (rows: Tx[], cat?: string) => rows.filter((t) => t.amountPence > 0 && real(t) && (!cat || t.category === cat)).reduce((n, t) => n + t.amountPence, 0);

  const insights: Insight[] = [];
  const totalOut = out(now);
  const totalIn = inn(now);
  const takings = inn(now, 'Card & online takings') + inn(now, 'Cash & cheques paid in');
  if (!now.length) return { insights, recurring: [], suppliers: [], totals: { totalIn, totalOut, takings } };

  // Overall position.
  if (totalIn && totalOut) {
    const diff = totalIn - totalOut;
    insights.push(
      diff >= 0
        ? { tone: 'good', title: `${money(diff)} more came in than went out`, detail: `${money(totalIn)} in and ${money(totalOut)} out over the period (transfers between your own accounts left out).` }
        : { tone: 'warn', title: `${money(-diff)} more went out than came in`, detail: `${money(totalIn)} in and ${money(totalOut)} out. Normal in months you’re buying stock ahead of the season — worth checking it’s planned.` },
    );
  }

  // Stock buying against takings.
  const stock = out(now, 'Stock & suppliers');
  if (stock && takings) {
    const r = pct(stock, takings);
    insights.push({
      tone: r > 75 ? 'warn' : 'info',
      title: `Stock purchases were ${r}% of takings`,
      detail: `${money(stock)} paid to suppliers against ${money(takings)} taken. ${r > 75 ? 'High — either you’re building stock for the season, or margin is being squeezed. Compare with the stock held on the Stock page.' : 'Golf retail typically buys stock at around 55–65% of the selling price.'}`,
    });
  }

  // Staff costs.
  const wages = out(now, 'Wages'); // PAYE paid to HMRC is grouped with VAT, so it isn't counted here
  if (wages && takings) {
    const r = pct(wages, takings);
    insights.push({ tone: r > 25 ? 'warn' : 'info', title: `Wages paid were ${r}% of takings`, detail: `${money(wages)} in wage payments. Many independent golf shops aim for 15–25%. Tax and NI paid to HMRC are counted separately.` });
  }

  // Insurance, annualised.
  const ins = out(year, 'Insurance');
  if (ins) insights.push({ tone: 'info', title: `Insurance costs ${money(ins)} a year`, detail: `About ${money(ins / 12)} a month over the last 12 months of statements. Worth a quote comparison at renewal.` });

  // Fees as a share of card takings.
  const fees = out(now, 'Bank & card fees');
  const card = inn(now, 'Card & online takings');
  if (fees && card) {
    const r = Math.round((fees / card) * 1000) / 10;
    insights.push({ tone: r > 2.5 ? 'warn' : 'info', title: `Bank and card fees: ${r}% of card takings`, detail: `${money(fees)} in fees. ${r > 2.5 ? 'Above the usual 1.5–2.5% — worth asking your card provider for a better rate.' : 'In the usual range for a small retailer.'}` });
  }

  // Biggest movers against the period before.
  const cats = [...new Set(now.concat(before).filter((t) => t.amountPence < 0 && real(t)).map((t) => t.category))];
  // Only compare when the statements cover the whole of the earlier period (else it looks like a huge jump).
  const earliest = before.reduce((m, t) => (t.date < m ? t.date : m), '9999');
  const covered = before.length > 0 && new Date(`${earliest}T12:00:00Z`).getTime() - new Date(`${prevFrom}T12:00:00Z`).getTime() <= 10 * 86_400_000;
  const movers = (covered ? cats : [])
    .map((c) => ({ c, now: out(now, c), before: out(before, c) }))
    .filter((m) => m.before > 0 && Math.abs(m.now - m.before) >= 20000 && Math.abs(m.now - m.before) / m.before >= 0.25)
    .sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before))
    .slice(0, 3);
  for (const m of movers) {
    const up = m.now > m.before;
    insights.push({
      tone: up ? 'warn' : 'good',
      title: `${m.c} ${up ? 'up' : 'down'} ${Math.abs(pct(m.now - m.before, m.before))}%`,
      detail: `${money(m.now)} against ${money(m.before)} in the period before.`,
    });
  }

  // Biggest share of spending.
  const top = cats.map((c) => ({ c, v: out(now, c) })).sort((a, b) => b.v - a.v)[0];
  if (top && totalOut) insights.push({ tone: 'info', title: `${top.c} is the biggest cost: ${pct(top.v, totalOut)}% of spending`, detail: `${money(top.v)} of ${money(totalOut)} paid out.` });

  // Uncategorised.
  const other = out(now, 'Other spending') + out(now, 'Uncategorised');
  if (other && pct(other, totalOut) >= 15) {
    insights.push({ tone: 'info', title: `${pct(other, totalOut)}% of spending isn’t categorised`, detail: 'Sort a few of the “Other spending” transactions below — COS remembers, so the figures get sharper each month.' });
  }

  // Regular payments (subscriptions, rent, insurance, loans): the same payee in 3+ of the last 6 months.
  const six = year.filter((t) => t.date >= shiftMonths(to, -6) && t.amountPence < 0 && real(t));
  const groups = new Map<string, { name: string; months: Set<string>; amounts: number[]; category: string; last: string }>();
  for (const t of six) {
    const name = ruleMatchFor(t.description) || t.description.slice(0, 30);
    const k = name.toLowerCase();
    const g = groups.get(k) ?? { name, months: new Set(), amounts: [], category: t.category, last: t.date };
    g.months.add(t.date.slice(0, 7));
    g.amounts.push(-t.amountPence);
    if (t.date > g.last) g.last = t.date;
    groups.set(k, g);
  }
  const recurring = [...groups.values()]
    .filter((g) => g.months.size >= 3 && g.category !== 'Stock & suppliers' && g.category !== 'Wages')
    .map((g) => ({ name: g.name, category: g.category, monthlyPence: Math.round(g.amounts.reduce((a, b) => a + b, 0) / g.months.size), months: g.months.size, last: g.last }))
    .sort((a, b) => b.monthlyPence - a.monthlyPence);
  if (recurring.length) {
    const monthly = recurring.reduce((n, r) => n + r.monthlyPence, 0);
    insights.push({ tone: 'info', title: `${recurring.length} regular payments: about ${money(monthly)} a month`, detail: `${money(monthly * 12)} a year. Listed below — check each one is still worth paying for.` });
  }

  // What each supplier has been paid over the last 12 months.
  const sup = new Map<string, number>();
  for (const t of year) {
    if (t.amountPence >= 0 || !real(t)) continue;
    const s = supplierFor(t.description);
    if (s) sup.set(s, (sup.get(s) ?? 0) + -t.amountPence);
  }
  const suppliers = [...sup.entries()].map(([name, pence]) => ({ name, pence })).sort((a, b) => b.pence - a.pence);

  return { insights, recurring, suppliers, totals: { totalIn, totalOut, takings } };
}
