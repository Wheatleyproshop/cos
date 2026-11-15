import { parseBankAmount, parseBankDate } from './bank-csv';
import { parseCsv } from './csv';
import { categoryFor, cleanBrand } from './stock-csv';

/**
 * Reads Shopify Analytics report exports for sales history:
 *  - "Sales over time" (by day, week or month): monthly totals
 *  - "Sales by product vendor" / "by product type", with or without a month column
 * Sales are taken as Shopify reports them, including VAT: net sales (after discounts and returns) + taxes.
 * If there's no Taxes column, "Total sales" less shipping is used; failing that, net sales.
 */

export type HistoryRow = { month: string; months: number; dimension: 'total' | 'brand' | 'category'; name: string; salesPence: number; discountPence: number; quantity: number; orders: number };
export class HistoryCsvError extends Error {}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
const col = (h: string[], ...names: string[]) => {
  const n = h.map(norm);
  for (const x of names) {
    const i = n.indexOf(norm(x));
    if (i >= 0) return i;
  }
  return -1;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "2025-03-01", "01/03/2025", "Mar 2025", "March 2025", "2025-03" → "2025-03-01". */
export function monthOf(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-01`;
  const d = parseBankDate(s);
  return d ? `${d.slice(0, 7)}-01` : null;
}

const money = (v: string | undefined) => parseBankAmount((v ?? '').replace(/[^\d.,()+-]/g, '') || '') ?? 0;

/** `year` is used for reports without a date column (e.g. a whole-year "sales by vendor"). */
export function parseSalesHistory(text: string, opts: { year?: number } = {}): HistoryRow[] {
  const table = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  if (table.length < 2) throw new HistoryCsvError('That file is empty.');
  const h = table[0];
  const iDate = col(h, 'Month', 'Day', 'Week', 'Date', 'Hour', 'Quarter', 'Year');
  const iVendor = col(h, 'Product vendor', 'Vendor', 'Brand');
  const iType = col(h, 'Product type', 'Type', 'Category');
  const iNet = col(h, 'Net sales', 'Net Sales');
  const iTax = col(h, 'Taxes', 'Tax');
  const iTotal = col(h, 'Total sales', 'Total Sales');
  const iShip = col(h, 'Shipping charges', 'Shipping');
  const iDisc = col(h, 'Discounts');
  const iQty = col(h, 'Net quantity', 'Net items sold', 'Quantity', 'Items sold', 'Net quantity sold');
  const iOrders = col(h, 'Orders');
  if (iNet < 0 && iTotal < 0) throw new HistoryCsvError('Couldn’t find a “Net sales” or “Total sales” column. Use a Shopify sales report export (Analytics → Reports → Sales over time, or Sales by product vendor).');
  const dimension: HistoryRow['dimension'] = iVendor >= 0 ? 'brand' : iType >= 0 ? 'category' : 'total';
  if (iDate < 0 && dimension === 'total') throw new HistoryCsvError('This report has no Month or Day column. Export “Sales over time” grouped by month.');
  if (iDate < 0 && !opts.year) throw new HistoryCsvError('This report has no dates — choose which year it covers.');
  const yearMode = iDate >= 0 && norm(h[iDate]) === 'year';

  const acc = new Map<string, HistoryRow>();
  for (const r of table.slice(1)) {
    const name = dimension === 'brand' ? cleanBrand(r[iVendor] ?? '') : dimension === 'category' ? categoryFor(r[iType] ?? '', '', '') : '';
    if (dimension !== 'total' && !name) continue;
    let month: string | null;
    let months = 1;
    if (iDate < 0) {
      month = `${opts.year}-01-01`;
      months = 12;
    } else if (yearMode) {
      const y = (r[iDate] ?? '').trim().match(/^\d{4}$/)?.[0];
      month = y ? `${y}-01-01` : null;
      months = 12;
    } else month = monthOf(r[iDate] ?? '');
    if (!month) continue; // totals rows and blank lines
    const net = iNet >= 0 ? money(r[iNet]) : 0;
    const sales = iNet >= 0 && iTax >= 0 ? net + money(r[iTax]) : iTotal >= 0 ? money(r[iTotal]) - (iShip >= 0 ? money(r[iShip]) : 0) : net;
    const key = `${month}|${months}|${name.toLowerCase()}`;
    const g = acc.get(key) ?? { month, months, dimension, name, salesPence: 0, discountPence: 0, quantity: 0, orders: 0 };
    g.salesPence += sales;
    g.discountPence += Math.abs(iDisc >= 0 ? money(r[iDisc]) : 0);
    g.quantity += iQty >= 0 ? Math.round(Number((r[iQty] ?? '0').replace(/[^\d.-]/g, '')) || 0) : 0;
    g.orders += iOrders >= 0 ? Math.round(Number((r[iOrders] ?? '0').replace(/[^\d.-]/g, '')) || 0) : 0;
    acc.set(key, g);
  }
  if (!acc.size) throw new HistoryCsvError('No sales found in that file.');
  return [...acc.values()];
}
