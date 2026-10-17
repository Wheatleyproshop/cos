import type { Organisation } from '@/db/schema';
import type { Performance, Ranked } from '../analytics';
import { resolveBrand } from '../branding';
import { money } from '../format';

/**
 * The monthly performance report sent to the shop's owner/managers (staff-facing, not customers).
 * Email-client-safe tables and inline styles; the full figures travel as the attached CSV.
 */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const INK = '#090a11';
const MUTED = '#6b6f7b';
const LINE = '#ecebe7';

function delta(pct: number | null) {
  if (pct === null) return '';
  const up = pct > 0;
  const colour = pct === 0 ? MUTED : up ? '#1b6b35' : '#a3322a';
  const bg = pct === 0 ? '#f0f2f5' : up ? '#e6f4ea' : '#fdecea';
  return `<span style="display:inline-block;font-size:11px;font-weight:700;color:${colour};background:${bg};border-radius:10px;padding:2px 7px;margin-left:6px">${pct > 0 ? '▲' : pct < 0 ? '▼' : '•'} ${Math.abs(pct)}%</span>`;
}

function kpi(label: string, value: string, note: string) {
  // Fluid inline blocks: three across on desktop, wrapping to two or one on a phone.
  return `<div style="display:inline-block;vertical-align:top;width:100%;max-width:186px;box-sizing:border-box;padding:5px"><div style="border:1px solid ${LINE};border-radius:10px;padding:12px 14px;text-align:left">
<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1px">${esc(label)}</div>
<div style="font-size:22px;font-weight:700;color:${INK};margin:4px 0 2px">${value}</div>
<div style="font-size:12px;color:${MUTED}">${note}</div></div></div>`;
}

function rankRows(rows: Ranked[], accent: string, by: 'value' | 'count') {
  if (!rows.length) return `<p style="font-size:13px;color:${MUTED};margin:0">No sales this month.</p>`;
  const max = Math.max(...rows.map((r) => (by === 'value' ? r.valuePence : r.count)), 1);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows
    .slice(0, 5)
    .map((r, i) => {
      const v = by === 'value' ? r.valuePence : r.count;
      const pct = Math.max(3, Math.round((v / max) * 100));
      return `<tr><td style="padding:6px 0;font-size:13px;color:${INK}">${i + 1}. ${esc(r.name)}<div style="height:6px;background:#f0f2f5;border-radius:4px;margin-top:5px"><div style="height:6px;width:${pct}%;background:${accent};border-radius:4px"></div></div></td>
<td style="padding:6px 0 6px 12px;font-size:13px;color:${INK};text-align:right;white-space:nowrap;vertical-align:top"><b>${by === 'value' ? esc(money(r.valuePence)) : r.count}</b><div style="font-size:11px;color:${MUTED}">${r.count} sold</div></td></tr>`;
    })
    .join('')}</table>`;
}

function section(title: string, body: string) {
  return `<tr><td style="padding:18px 26px 4px"><h2 style="font-size:16px;margin:0 0 10px;color:${INK}">${esc(title)}</h2>${body}</td></tr>`;
}

/** Pre-book stock received in the month, on-time rate by brand, and what's still due. Omitted when there's nothing to show. */
function arrivalsHtml(p: Performance) {
  const a = p.arrivals;
  if (!a.receivedItems && !a.outstandingItems) return '';
  const cell = (label: string, value: string, note: string, alert = false) =>
    `<div style="display:inline-block;vertical-align:top;width:50%;max-width:147px;min-width:130px;box-sizing:border-box;padding:4px;text-align:left"><div style="border:1px solid ${alert ? '#f2c79a' : LINE};background:${alert ? '#fff8f0' : '#fff'};border-radius:10px;padding:10px 12px">
<div style="font-size:11px;color:${MUTED}">${esc(label)}</div><div style="font-size:17px;font-weight:700;color:${INK};margin:2px 0">${esc(value)}</div><div style="font-size:11px;color:${MUTED}">${esc(note)}</div></div></div>`;
  const brands = a.byBrand.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-top:12px">
<tr style="color:${MUTED};font-size:11px;text-transform:uppercase;letter-spacing:.5px"><td style="padding:4px 0">Brand</td><td align="right">Items</td><td align="right">Value</td><td align="right">On time</td><td align="right">Avg late</td></tr>
${a.byBrand
  .slice(0, 8)
  .map(
    (b) =>
      `<tr><td style="padding:6px 0;border-top:1px solid ${LINE};color:${INK}"><b>${esc(b.brand)}</b></td><td align="right" style="border-top:1px solid ${LINE}">${b.items}</td><td align="right" style="border-top:1px solid ${LINE}">${esc(money(b.valuePence))}</td><td align="right" style="border-top:1px solid ${LINE};color:${b.onTimePct !== null && b.onTimePct < 75 ? '#a3322a' : INK}">${b.onTimePct === null ? '—' : `${b.onTimePct}%`}</td><td align="right" style="border-top:1px solid ${LINE};color:${MUTED}">${b.avgDaysLate === null ? '—' : `${b.avgDaysLate} days`}</td></tr>`,
  )
  .join('')}</table>`
    : `<p style="font-size:13px;color:${MUTED};margin:12px 0 0">No pre-book stock arrived this month.</p>`;
  const due = a.upcoming.length
    ? `<div style="font-size:12px;color:${MUTED};margin-top:12px">Due in: ${a.upcoming
        .slice(0, 3)
        .map((m) => `<b style="color:${INK}">${esc(m.label)}</b> ${esc(money(m.valuePence))} (${m.items} items)`)
        .join(' · ')}</div>`
    : '';
  return section(
    'Pre-book arrivals',
    `<div style="font-size:0;margin:0 -4px">${cell('Received', money(a.receivedValuePence), `${a.receivedItems} items at cost`)}${cell('On time', a.onTimePct === null ? '—' : `${a.onTimePct}%`, 'by expected date')}${cell('Still to arrive', money(a.outstandingValuePence), `${a.outstandingItems} items`)}${cell('Overdue', String(a.overdueLines), 'lines past date', a.overdueLines > 0)}</div>${brands}${due}`,
  );
}

export function renderPerformanceEmail(org: Organisation, p: Performance, link: string) {
  const b = resolveBrand(org);
  const k = p.kpis;
  const accent = b.accent;
  const subject = `${org.storeName} — ${p.period.label} performance`;

  const turnaround = p.turnaround.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
<tr style="color:${MUTED};font-size:11px;text-transform:uppercase;letter-spacing:.5px"><td style="padding:4px 0">Manufacturer</td><td align="right">Orders</td><td align="right">Average</td><td align="right">Range</td><td align="right">Delayed</td></tr>
${p.turnaround
  .slice(0, 8)
  .map(
    (t) =>
      `<tr><td style="padding:6px 0;border-top:1px solid ${LINE};color:${INK}"><b>${esc(t.brand)}</b></td><td align="right" style="border-top:1px solid ${LINE}">${t.orders}</td><td align="right" style="border-top:1px solid ${LINE}"><b>${t.avgDays} days</b></td><td align="right" style="border-top:1px solid ${LINE};color:${MUTED}">${t.minDays}–${t.maxDays}</td><td align="right" style="border-top:1px solid ${LINE};color:${t.delayedPct >= 25 ? '#a3322a' : INK}">${t.delayedPct}%</td></tr>`,
  )
  .join('')}</table>`
    : `<p style="font-size:13px;color:${MUTED};margin:0">No orders arrived in store this month.</p>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:24px 10px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #e6e4df">
<tr><td style="background:${b.headerBg};padding:18px 26px;color:${b.headerText}">
<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.8">${esc(org.storeName)} · Monthly performance</div>
<div style="font-size:24px;font-weight:700;margin-top:4px">${esc(p.period.label)}</div></td></tr>
<tr><td style="padding:16px 18px 0;text-align:center;font-size:0">${kpi('Order value', `${esc(money(k.valuePence))}`, `${delta(k.valueChange)} vs previous month`)}${kpi('Orders', `${k.orders}`, `${delta(k.ordersChange)} avg ${esc(money(k.avgOrderPence))}`)}${kpi('Quotes approved', k.approvalRate === null ? '—' : `${k.approvalRate}%`, `${k.quotesApproved} of ${k.quotes}`)}${kpi('Avg turnaround', k.avgTurnaroundDays === null ? '—' : `${k.avgTurnaroundDays} days`, `${k.arrived} arrived in store`)}${kpi('Repeat customers', k.repeatPct === null ? '—' : `${k.repeatPct}%`, `${k.customers} customers`)}${kpi('In the pipeline', esc(money(k.openValuePence)), `${k.openOrders} open orders now`)}</td></tr>
${section('Best-selling brands', rankRows(p.brands, accent, 'value'))}
${section('Best-selling products', rankRows(p.products, accent, 'count'))}
${section('Manufacturer turnaround', `<div style="font-size:12px;color:${MUTED};margin:-6px 0 8px">Days from order taken to arriving in store</div>${turnaround}`)}
${arrivalsHtml(p)}
${section('Sales by team member', rankRows(p.team, accent, 'value'))}
<tr><td style="padding:22px 26px 8px"><a href="${esc(link)}" style="display:inline-block;background:${accent};color:${b.accentText};text-decoration:none;padding:12px 20px;border-radius:${b.radius};font-weight:600;font-size:14px">Open Performance in COS</a></td></tr>
<tr><td style="padding:8px 26px 24px;font-size:12px;color:${MUTED};line-height:1.6">The full figures are attached as a spreadsheet (CSV). You receive this because you're on the monthly report list in Store settings.</td></tr>
</table></td></tr></table></body></html>`;

  const lines = [
    `${org.storeName} — ${p.period.label} performance`,
    '',
    `Order value: ${money(k.valuePence)}${k.valueChange !== null ? ` (${k.valueChange > 0 ? '+' : ''}${k.valueChange}% vs previous month)` : ''}`,
    `Orders: ${k.orders} (average ${money(k.avgOrderPence)})`,
    `Quotes approved: ${k.approvalRate === null ? '—' : `${k.approvalRate}%`} (${k.quotesApproved} of ${k.quotes})`,
    `Average turnaround: ${k.avgTurnaroundDays === null ? '—' : `${k.avgTurnaroundDays} days`}`,
    `Repeat customers: ${k.repeatPct === null ? '—' : `${k.repeatPct}%`}`,
    `In the pipeline: ${money(k.openValuePence)} (${k.openOrders} open orders)`,
    '',
    'Best-selling brands:',
    ...p.brands.slice(0, 5).map((r, i) => `  ${i + 1}. ${r.name} — ${money(r.valuePence)} (${r.count} sold)`),
    '',
    'Manufacturer turnaround (order to in store):',
    ...p.turnaround.slice(0, 8).map((t) => `  ${t.brand}: ${t.avgDays} days average (${t.minDays}–${t.maxDays}), ${t.delayedPct}% delayed`),
    ...(p.arrivals.receivedItems || p.arrivals.outstandingItems
      ? [
          '',
          'Pre-book arrivals:',
          `  Received: ${money(p.arrivals.receivedValuePence)} (${p.arrivals.receivedItems} items at cost)${p.arrivals.onTimePct !== null ? `, ${p.arrivals.onTimePct}% on time` : ''}`,
          `  Still to arrive: ${money(p.arrivals.outstandingValuePence)} (${p.arrivals.outstandingItems} items), ${p.arrivals.overdueLines} overdue line${p.arrivals.overdueLines === 1 ? '' : 's'}`,
          ...p.arrivals.byBrand.slice(0, 8).map((b) => `  ${b.brand}: ${b.items} items, ${money(b.valuePence)}${b.onTimePct !== null ? `, ${b.onTimePct}% on time` : ''}`),
        ]
      : []),
    '',
    `Open Performance in COS: ${link}`,
    'The full figures are attached as a CSV.',
  ];
  return { subject, html, text: lines.join('\n') };
}
