import { requireBusiness } from '@/lib/business-lock';
import { csvRow } from '@/lib/csv';
import { todayInTz } from '@/lib/format';
import { CHECKS, stockChecks, type CheckKey } from '@/lib/services/business/advice';

/** One stock check as a spreadsheet, to work through in Shopify. */
export async function GET(req: Request) {
  const staff = await requireBusiness({ renew: true });
  const check = new URL(req.url).searchParams.get('check') as CheckKey | null;
  if (!check || !(check in CHECKS)) return new Response('Unknown check', { status: 400 });
  const today = todayInTz(staff.org.timezone);
  const from = new Date(new Date(`${today}T12:00:00Z`).getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(new Date(`${today}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const c = await stockChecks(staff.organisationId, from, to);
  const rows = c ? c[check] : [];
  const g = (p: number | null) => (p == null ? '' : (p / 100).toFixed(2));
  const csv =
    '﻿' +
    [csvRow([CHECKS[check].title]), csvRow(['Brand', 'Product', 'Variant', 'SKU', 'Quantity', 'Cost per item', 'Price', 'Note']), ...rows.map((r) => csvRow([r.brand, r.title, r.variant, r.sku, r.quantity, g(r.costPence), g(r.pricePence), r.note]))].join('\r\n') +
    '\r\n';
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="stock-check-${check}-${today}.csv"`, 'Cache-Control': 'private, no-store' },
  });
}
