import type { Organisation } from '@/db/schema';
import type { Performance, ReportRange } from './analytics';
import { csvRow } from './csv';
import { todayInTz } from './format';

const gbp = (pence: number) => (pence / 100).toFixed(2);

/** Midnight on the 1st of a month in the shop's time zone, as an instant. */
export function zonedMonthStart(year: number, monthIndex: number, tz: string): Date {
  const guess = new Date(Date.UTC(year, monthIndex, 1));
  const wall = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (wall.getTime() - utc.getTime()));
}

/** The calendar month before `now` (in the shop's time zone), e.g. all of October when run on 1 November. */
export function previousMonth(tz: string, now = new Date()): ReportRange & { monthKey: string } {
  const [y, m] = todayInTz(tz, now).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const py = prev.getUTCFullYear();
  const pm = prev.getUTCMonth();
  return {
    key: 'month',
    label: prev.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    from: zonedMonthStart(py, pm, tz),
    to: zonedMonthStart(y, m - 1, tz),
    prevFrom: zonedMonthStart(py, pm - 1, tz),
    monthKey: `${py}-${String(pm + 1).padStart(2, '0')}`,
  };
}

/** The Performance figures as one CSV with a titled section per table (download and monthly email). */
export function performanceCsv(org: Pick<Organisation, 'storeName'>, p: Performance, asOf: string): string {
  const k = p.kpis;
  const out: string[] = [];
  const section = (title: string, header: string[], rows: unknown[][]) => {
    if (out.length) out.push('');
    out.push(csvRow([title]));
    out.push(csvRow(header));
    if (rows.length) rows.forEach((r) => out.push(csvRow(r)));
    else out.push(csvRow(['No data for this period']));
  };
  section(`${org.storeName} performance — ${p.period.label} (to ${asOf})`, ['Measure', 'Value'], [
    ['Period start', p.from.toISOString().slice(0, 10)],
    ['Order value (GBP)', gbp(k.valuePence)],
    ['Change vs previous period (%)', k.valueChange ?? ''],
    ['Orders', k.orders],
    ['Change in orders vs previous period (%)', k.ordersChange ?? ''],
    ['Average order (GBP)', gbp(k.avgOrderPence)],
    ['Customers', k.customers],
    ['Repeat customers (%)', k.repeatPct ?? ''],
    ['Quotes sent', k.quotes],
    ['Quotes approved', k.quotesApproved],
    ['Quote approval rate (%)', k.approvalRate ?? ''],
    ['Average days to approve', k.avgApproveDays ?? ''],
    ['Orders arrived in store', k.arrived],
    ['Average turnaround (days)', k.avgTurnaroundDays ?? ''],
    ['Open orders (now)', k.openOrders],
    ['Open order value (GBP, now)', gbp(k.openValuePence)],
  ]);
  section('Sales trend', ['Period starting', 'Orders', 'Order value (GBP)'], p.trend.map((b) => [b.start.toISOString().slice(0, 10), b.count, gbp(b.valuePence)]));
  section('Best-selling brands', ['Rank', 'Brand', 'Items sold', 'Value (GBP)'], p.brands.map((r, i) => [i + 1, r.name, r.count, gbp(r.valuePence)]));
  section('Best-selling products', ['Rank', 'Product', 'Items sold', 'Value (GBP)'], p.products.map((r, i) => [i + 1, r.name, r.count, gbp(r.valuePence)]));
  section("What's selling", ['Type', 'Items sold', 'Value (GBP)'], p.categories.map((r) => [r.name, r.count, gbp(r.valuePence)]));
  section(
    'Manufacturer turnaround (days from order taken to in store)',
    ['Manufacturer', 'Orders arrived', 'Average days', 'Median days', 'Fastest days', 'Slowest days', 'Supplier lead days', 'Delayed (%)'],
    p.turnaround.map((t) => [t.brand, t.orders, t.avgDays, t.medianDays, t.minDays, t.maxDays, t.supplierAvgDays ?? '', t.delayedPct]),
  );
  const a = p.arrivals;
  section('Pre-book arrivals', ['Measure', 'Value'], [
    ['Stock received in period (items)', a.receivedItems],
    ['Stock received in period (GBP at cost)', gbp(a.receivedValuePence)],
    ['Arrived by expected date (%)', a.onTimePct ?? ''],
    ['Still to arrive (items, now)', a.outstandingItems],
    ['Still to arrive (GBP at cost, now)', gbp(a.outstandingValuePence)],
    ['Overdue lines (now)', a.overdueLines],
  ]);
  section('Pre-book stock received by brand', ['Brand', 'Items', 'Value at cost (GBP)', 'On time (%)', 'Average days late'], a.byBrand.map((b) => [b.brand, b.items, gbp(b.valuePence), b.onTimePct ?? '', b.avgDaysLate ?? '']));
  section('Pre-book stock due in', ['Month', 'Items', 'Value at cost (GBP)'], a.upcoming.map((m) => [m.label, m.items, gbp(m.valuePence)]));
  section('Order mix', ['Type', 'Orders', 'Value (GBP)'], p.mix.map((r) => [r.name, r.count, gbp(r.valuePence)]));
  section('Sales by team member', ['Team member', 'Orders', 'Value (GBP)'], p.team.map((r) => [r.name, r.count, gbp(r.valuePence)]));
  // BOM so Excel opens £ signs and accents correctly.
  return '﻿' + out.join('\r\n') + '\r\n';
}
