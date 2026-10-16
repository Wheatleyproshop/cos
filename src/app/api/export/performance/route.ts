import { withTenant } from '@/db';
import { getPerformance, parsePeriod } from '@/lib/analytics';
import { recordEvent, staffActor } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { csvRow } from '@/lib/csv';

const gbp = (pence: number) => (pence / 100).toFixed(2);

/** The Performance view's figures as one CSV, a titled section per table. Managers and owners only (it includes team sales). */
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  if (!hasRole(staff, 'manager')) return new Response('Only a manager or owner can export performance figures.', { status: 403 });
  const period = parsePeriod(new URL(req.url).searchParams.get('period') ?? undefined);
  const p = await getPerformance(staff.org, period);
  const k = p.kpis;
  const today = new Date().toISOString().slice(0, 10);

  const out: string[] = [];
  const section = (title: string, header: string[], rows: unknown[][]) => {
    if (out.length) out.push('');
    out.push(csvRow([title]));
    out.push(csvRow(header));
    if (rows.length) rows.forEach((r) => out.push(csvRow(r)));
    else out.push(csvRow(['No data for this period']));
  };

  section(`${staff.org.storeName} performance — ${p.period.label} to ${today}`, ['Measure', 'Value'], [
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
  section('Order mix', ['Type', 'Orders', 'Value (GBP)'], p.mix.map((r) => [r.name, r.count, gbp(r.valuePence)]));
  section('Sales by team member', ['Team member', 'Orders', 'Value (GBP)'], p.team.map((r) => [r.name, r.count, gbp(r.valuePence)]));

  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor(staff), eventType: 'data_exported', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { format: 'csv', report: 'performance', period },
    }),
  );

  // BOM so Excel opens the £ and accents correctly.
  return new Response('﻿' + out.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="performance-${period}-${today}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
