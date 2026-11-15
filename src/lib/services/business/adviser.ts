import type { Organisation } from '@/db/schema';
import { getPerformance } from '../../analytics';
import { todayInTz } from '../../format';
import { marginStory, stockChecks } from './advice';
import { brandReview } from './brand-review';
import { spendingInsights } from './insights';
import { commitments, stockReport } from './stock';
import { corporationTaxForecast, financeSettings, vatForecast } from './tax';

/**
 * The Business adviser: one ranked list of what to do next, from everything COS knows. Each item
 * says why, roughly what it's worth, and where to act. Rules of thumb for a golf shop — not
 * professional advice.
 */

export type Advice = {
  priority: 1 | 2 | 3; // 1 = do this week
  area: 'Stock' | 'Margin' | 'Cash & tax' | 'Costs' | 'Staff' | 'Data';
  title: string;
  detail: string;
  worthPence?: number;
  href?: string;
};

const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString('en-GB')}`;
const add = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export async function businessAdvice(org: Organisation) {
  const today = todayInTz(org.timezone);
  const from90 = add(today, -90);
  const to = add(today, 1);
  const fin = financeSettings(org.finance);
  const [checks, review, story, spend, stock, committed, perf, vat, ct] = await Promise.all([
    stockChecks(org.id, from90, to),
    brandReview(org.id, from90, to),
    marginStory(org.id, from90, to),
    spendingInsights(org.id, add(today, -90), to, 3),
    stockReport(org.id),
    commitments(org.id),
    getPerformance(org, '90d'),
    fin.vatRegistered ? vatForecast(org.id, fin, today) : Promise.resolve(null),
    fin.limitedCompany ? corporationTaxForecast(org.id, fin, today) : Promise.resolve(null),
  ]);
  const advice: Advice[] = [];

  // ── Cash & tax: money to put aside before it's due.
  const vq = vat?.quarters.find((q) => q.current);
  if (vq && vq.payable > 0) {
    advice.push({
      priority: daysUntil(today, vq.due) <= 45 ? 1 : 2, area: 'Cash & tax',
      title: `Put aside about ${pounds(vq.payable)} for VAT (${vq.label}), due ${fmt(vq.due)}`,
      detail: `Estimated from sales so far and the current rate of sale (${vq.estimatedShare}% of the quarter still estimated). ${vq.inputFrom === 'estimate' ? 'Purchase VAT is estimated from cost of goods sold — upload bank statements for actual figures.' : ''}`.trim(),
      worthPence: vq.payable, href: '/business/adviser#tax',
    });
  }
  const prevQ = vat?.quarters.find((q) => !q.current && !q.future);
  if (prevQ && prevQ.payable > 0 && prevQ.due >= today) {
    advice.push({ priority: 1, area: 'Cash & tax', title: `VAT for ${prevQ.label} — about ${pounds(prevQ.payable)} due ${fmt(prevQ.due)}`, detail: 'File through your MTD software and pay by the due date.', worthPence: prevQ.payable, href: '/business/adviser#tax' });
  }
  if (ct?.tax && ct.tax > 0) {
    advice.push({
      priority: 2, area: 'Cash & tax',
      title: `Put aside about ${pounds(ct.perMonth ?? 0)} a month for corporation tax`,
      detail: `Estimated ${pounds(ct.tax)} on about ${pounds(ct.profit ?? 0)} profit for the ${ct.label}, due ${fmt(ct.due)}. ${ct.overheads === null ? 'Running costs aren’t included yet — upload bank statements, or the estimate will be too high.' : ''}`.trim(),
      worthPence: ct.tax, href: '/business/adviser#tax',
    });
  }

  // ── Stock: money tied up that could be cash.
  for (const b of review.brands.filter((x) => x.weeksCover && x.weeksCover > 26 && x.weeksCover < 999 && x.stockCostPence >= 300_000).slice(0, 4)) {
    const excess = Math.round(b.stockCostPence * (1 - 12 / b.weeksCover!));
    advice.push({
      priority: excess > 500_000 ? 1 : 2, area: 'Stock',
      title: `${b.name}: about ${pounds(excess)} more stock than you need`,
      detail: `${b.weeksCover} weeks of stock at the current rate of sale (12 weeks is a healthy level). Pause re-orders, ask the rep about returns or swaps, and promote what’s on the shelf.`,
      worthPence: excess, href: `/business/brands?brand=${encodeURIComponent(b.name)}#items`,
    });
  }
  if (checks?.notSelling.length) {
    const tied = checks.notSelling.reduce((n, i) => n + i.valuePence, 0);
    advice.push({
      priority: 2, area: 'Stock', title: `${pounds(tied)} in ${checks.notSelling.length} lines that haven’t sold in 90 days`,
      detail: 'Move them to the front, bundle them, run a clearance or send them back. Each month on the shelf ties up cash.', worthPence: tied, href: '/business/stock#to-check',
    });
  }
  if (committed.prebookCostPence > 0 && stock.latest) {
    advice.push({
      priority: 3, area: 'Stock', title: `${pounds(committed.prebookCostPence)} of pre-books still to arrive`,
      detail: `On top of ${pounds(stock.latest.costPence)} already in stock. Check what’s due against brands with lots of stock cover before it lands.`, href: '/business/stock',
    });
  }

  // ── Margin.
  const lowFull = story.filter((m) => m.fullMargin !== null && m.fullMargin < 30 && m.fullPence >= 100_000);
  if (lowFull.length) {
    advice.push({
      priority: 1, area: 'Margin', title: `Check cost prices for ${lowFull.slice(0, 3).map((m) => m.name).join(', ')}${lowFull.length > 3 ? ` and ${lowFull.length - 3} more` : ''}`,
      detail: 'Even at full price these show under 30% margin — usually costs typed in including VAT, or old costs. Fixing them makes every margin figure trustworthy.', href: '/business/brands#why',
    });
  }
  const discounters = story.filter((m) => m.fullPence >= 100_000 && m.realPence / m.fullPence >= 0.1).sort((a, b) => b.realPence - a.realPence);
  if (discounters.length) {
    const total = discounters.reduce((n, m) => n + m.realPence, 0);
    advice.push({
      priority: 2, area: 'Margin', title: `Discounts cost ${pounds(total)} on ${discounters.slice(0, 3).map((m) => m.name).join(', ')}`,
      detail: 'Over 10% off full price. Agree a discount limit with staff, and use bundles or a free extra (glove, balls) rather than money off.', worthPence: total, href: '/business/brands#why',
    });
  }
  if (checks && (checks.costTooHigh.length || checks.noCost.length || checks.soldNoCost.length)) {
    advice.push({
      priority: checks.soldNoCost.length ? 1 : 2, area: 'Data',
      title: `Fix ${checks.costTooHigh.length + checks.soldNoCost.length} cost prices in Shopify`,
      detail: `${checks.soldNoCost.length} items sold with no cost price, ${checks.costTooHigh.length} have costs that look too high, and ${checks.noCost.length} stock lines have no cost at all. Download the lists from the Stock page.`,
      href: '/business/stock#to-check',
    });
  }
  if (checks?.negative.length) {
    advice.push({ priority: 3, area: 'Data', title: `Count and correct ${checks.negative.length} lines showing negative stock`, detail: 'Usually sold before being booked in. Correct the levels in Shopify so stock value and cover are right.', href: '/business/stock#to-check' });
  }

  // ── Costs and staff.
  for (const i of spend.insights.filter((x) => x.tone === 'warn').slice(0, 3)) {
    advice.push({ priority: 2, area: 'Costs', title: i.title, detail: i.detail, href: '/business/bank' });
  }
  if (spend.recurring.length) {
    const monthly = spend.recurring.reduce((n, r) => n + r.monthlyPence, 0);
    advice.push({ priority: 3, area: 'Costs', title: `Review ${spend.recurring.length} regular payments (${pounds(monthly)} a month)`, detail: 'Cancel anything not used; ask for better rates on card fees, insurance and energy at renewal.', worthPence: monthly * 12, href: '/business/bank' });
  }

  // ── Missing data that would make this sharper.
  if (!spend.totals.totalOut) advice.push({ priority: 2, area: 'Data', title: 'Upload your bank statements', detail: 'Running costs, real purchase VAT and profit all come from them. Download CSVs from online banking for the last 12 months.', href: '/business/bank' });
  if (review.weeks < 26) advice.push({ priority: 3, area: 'Data', title: `Sales history is ${Math.round(review.weeks)} weeks so far`, detail: 'COS keeps every night’s sales from now on, so seasonal comparisons sharpen over the year. Rates of sale are based on the weeks it has.' });

  const order = { 1: 0, 2: 1, 3: 2 };
  advice.sort((a, b) => order[a.priority] - order[b.priority] || (b.worthPence ?? 0) - (a.worthPence ?? 0));
  return { advice, vat, ct, fin, review, stock, perf, today };
}

const daysUntil = (from: string, to: string) => Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
