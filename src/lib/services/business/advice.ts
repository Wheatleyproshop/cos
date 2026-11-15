import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { bankStatements, bankTransactions, organisations, shopSales, stockCatalogue, stockItems, stockSnapshots } from '@/db/schema';
import { supplierFor } from './insights';

/**
 * Practical to-do lists from the stock count and sales: what to check in Shopify (missing or
 * suspicious cost prices, negative stock), what isn't selling, and why each brand's margin is what
 * it is (full-price margin → real discounts → credit vouchers).
 */

const VAT = 1.2;

export type CheckItem = { key: string; sku: string; title: string; variant: string; brand: string; quantity: number; costPence: number | null; pricePence: number | null; note: string; valuePence: number };

export async function stockChecks(orgId: string, salesFrom: string, salesTo: string) {
  return withTenant(orgId, async (tx) => {
    const [snap] = await tx.select().from(stockSnapshots).where(isNull(stockSnapshots.removedAt)).orderBy(desc(stockSnapshots.takenOn), desc(stockSnapshots.createdAt)).limit(1);
    if (!snap) return null;
    const items = await tx.select().from(stockItems).where(eq(stockItems.snapshotId, snap.id));
    const sales = await tx.select({ key: shopSales.key, qty: shopSales.quantity }).from(shopSales).where(and(gte(shopSales.soldOn, salesFrom), lt(shopSales.soldOn, salesTo)));
    const sold = new Map<string, number>();
    for (const s of sales) if (s.key) sold.set(s.key, (sold.get(s.key) ?? 0) + s.qty);
    // Sold lines whose product has no cost price at all (so their margin can't be worked out).
    const catalogue = await tx.select({ key: stockCatalogue.key, sku: stockCatalogue.sku, title: stockCatalogue.title, variant: stockCatalogue.variant, brand: stockCatalogue.brand, cost: stockCatalogue.costPence, price: stockCatalogue.pricePence }).from(stockCatalogue);
    const cat = new Map(catalogue.map((c) => [c.key, c]));

    const row = (i: (typeof items)[number], note: string, valuePence: number): CheckItem => ({
      key: i.key, sku: i.sku, title: i.title, variant: i.variant, brand: i.brand, quantity: i.quantity, costPence: i.costPence, pricePence: i.pricePence, note, valuePence,
    });
    const held = items.filter((i) => i.quantity > 0);

    const noCost = held
      .filter((i) => i.costPence == null || i.costPence === 0)
      .map((i) => row(i, 'No cost price', i.quantity * (i.pricePence ?? 0)))
      .sort((a, b) => b.valuePence - a.valuePence);

    // Cost at or above the selling price less VAT: almost always a typo, or a cost entered including VAT.
    const costTooHigh = held
      .filter((i) => i.costPence && i.pricePence && i.costPence >= i.pricePence / VAT)
      .map((i) => row(i, `Cost ${(i.costPence! / 100).toFixed(2)} vs price ${(i.pricePence! / 100).toFixed(2)} — no margin`, i.quantity * i.costPence!))
      .sort((a, b) => b.valuePence - a.valuePence);

    // Cost under 15% of the price less VAT: usually a missing digit or a per-pack cost on a single item.
    const costTooLow = held
      .filter((i) => i.costPence && i.pricePence && i.costPence < (i.pricePence / VAT) * 0.15)
      .map((i) => row(i, `Cost ${(i.costPence! / 100).toFixed(2)} vs price ${(i.pricePence! / 100).toFixed(2)} — looks too low`, i.quantity * (i.pricePence ?? 0)))
      .sort((a, b) => b.valuePence - a.valuePence);

    const negative = items
      .filter((i) => i.quantity < 0)
      .map((i) => row(i, `${i.quantity} in stock`, Math.abs(i.quantity) * (i.costPence ?? i.pricePence ?? 0)))
      .sort((a, b) => b.valuePence - a.valuePence);

    // Plenty in stock, nothing sold in the period.
    const notSelling = held
      .filter((i) => !sold.get(i.key) && i.quantity * (i.costPence ?? 0) >= 20_000)
      .map((i) => row(i, `${i.quantity} in stock, none sold`, i.quantity * (i.costPence ?? 0)))
      .sort((a, b) => b.valuePence - a.valuePence);

    const soldNoCost = [...sold.entries()]
      .map(([key, qty]) => ({ c: cat.get(key), qty }))
      .filter((x) => x.c && (x.c.cost == null || x.c.cost === 0))
      .map(({ c, qty }) => ({ key: c!.key, sku: c!.sku, title: c!.title, variant: c!.variant, brand: c!.brand, quantity: qty, costPence: null, pricePence: c!.price, note: `${qty} sold with no cost price`, valuePence: qty * (c!.price ?? 0) }))
      .sort((a, b) => b.valuePence - a.valuePence);

    return { snapTakenOn: snap.takenOn, noCost, costTooHigh, costTooLow, negative, notSelling, soldNoCost };
  });
}

export type StockChecks = NonNullable<Awaited<ReturnType<typeof stockChecks>>>;
export const CHECKS = {
  noCost: { title: 'Stock with no cost price', why: 'Left out of the stock value and margins. Add “Cost per item” in Shopify.' },
  soldNoCost: { title: 'Selling, but no cost price', why: 'These sold in the period, so their margin is unknown. Add “Cost per item” in Shopify.' },
  costTooHigh: { title: 'Cost looks too high', why: 'Cost is at or above the price less VAT — usually a typo, or a cost typed in including VAT.' },
  costTooLow: { title: 'Cost looks too low', why: 'Cost is under 15% of the price — often a missing digit, or a per-pack cost on a single item.' },
  negative: { title: 'Negative stock', why: 'Sold before it was booked in, or a miscount. Count it and correct the level in Shopify.' },
  notSelling: { title: 'In stock, not selling', why: 'Over £200 at cost each, with no sales in the period. Consider a promotion, moving it to the front, or returning it.' },
} as const;
export type CheckKey = keyof typeof CHECKS;

/**
 * Why each brand's margin is what it is: the margin it would make at full price, then what real
 * discounts take off, and what credit vouchers (not counted as discounts) would have taken if they were.
 */
export async function marginStory(orgId: string, from: string, to: string) {
  return withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ vouchers: organisations.voucherDiscounts }).from(organisations).limit(1);
    const vouchers = new Set((org?.vouchers ?? []).map((v) => v.toLowerCase()));
    const sales = await tx.select().from(shopSales).where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to)));
    const catalogue = await tx.select({ key: stockCatalogue.key, cost: stockCatalogue.costPence }).from(stockCatalogue);
    const cost = new Map(catalogue.map((c) => [c.key, c.cost]));
    const by = new Map<string, { name: string; full: number; real: number; voucher: number; cogs: number; topDiscounts: Map<string, number> }>();
    for (const s of sales) {
      const c = cost.get(s.key);
      if (s.quantity <= 0 || c == null || c === 0) continue;
      const k = s.brand.toLowerCase() || 'unknown';
      const g = by.get(k) ?? { name: s.brand || 'Unknown', full: 0, real: 0, voucher: 0, cogs: 0, topDiscounts: new Map() };
      g.full += s.unitPricePence * s.quantity;
      g.cogs += c * s.quantity;
      for (const d of s.discounts) {
        if (vouchers.has(d.name.toLowerCase())) g.voucher += d.pence;
        else {
          g.real += d.pence;
          g.topDiscounts.set(d.name, (g.topDiscounts.get(d.name) ?? 0) + d.pence);
        }
      }
      by.set(k, g);
    }
    const pct = (rev: number, cogs: number) => (rev > 0 ? Math.round(((rev / VAT - cogs) / (rev / VAT)) * 100) : null);
    return [...by.values()]
      .filter((g) => g.full >= 20_000)
      .map((g) => {
        const fullMargin = pct(g.full, g.cogs);
        const afterDiscounts = pct(g.full - g.real, g.cogs);
        const ifVoucherCounted = pct(g.full - g.real - g.voucher, g.cogs);
        const top = [...g.topDiscounts.entries()].sort((a, b) => b[1] - a[1])[0];
        const reasons: string[] = [];
        if (fullMargin !== null && fullMargin < 30) reasons.push(`even at full price it only makes ${fullMargin}% — check the cost prices, or whether costs were entered including VAT`);
        if (g.real / g.full >= 0.08) reasons.push(`discounts took ${Math.round((g.real / g.full) * 100)}% off full price${top ? ` (mostly “${top[0]}”)` : ''}`);
        if (g.voucher > 0) reasons.push(`${Math.round((g.voucher / g.full) * 100)}% was paid with credit vouchers — counted as money, so it doesn’t lower the margin here`);
        return { name: g.name, fullMargin, afterDiscounts, ifVoucherCounted, fullPence: g.full, realPence: g.real, voucherPence: g.voucher, reasons };
      })
      .sort((a, b) => b.fullPence - a.fullPence);
  });
}

/**
 * Spend with each supplier against what its brands sold, over the same weeks (the period both bank
 * statements and Shopify sales cover). Paid (less VAT) much higher than the cost of what sold = stock
 * building up; lower = selling down stock. Supplier accounts that cover several brands (e.g. Acushnet:
 * Titleist & FootJoy) are kept together.
 */
export async function supplierReturn(orgId: string, today: string) {
  return withTenant(orgId, async (tx) => {
    const [cov] = await tx
      .select({ salesFirst: sql<string | null>`(select min(sold_on)::text from shop_sales)`, bankFirst: sql<string | null>`min(${bankTransactions.date})::text`, bankLast: sql<string | null>`max(${bankTransactions.date})::text` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(isNull(bankStatements.removedAt));
    if (!cov?.salesFirst || !cov.bankFirst || !cov.bankLast) return null;
    const from = cov.salesFirst > cov.bankFirst ? cov.salesFirst : cov.bankFirst;
    const toEx = new Date(new Date(`${(cov.bankLast < today ? cov.bankLast : today)}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    if (from >= toEx) return null;
    const paid = await tx
      .select({ description: bankTransactions.description, amount: bankTransactions.amountPence })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(and(isNull(bankStatements.removedAt), gte(bankTransactions.date, from), lt(bankTransactions.date, toEx), sql`${bankTransactions.amountPence} < 0`));
    const [org] = await tx.select({ v: organisations.voucherDiscounts }).from(organisations).limit(1);
    const vouchers = new Set((org?.v ?? []).map((x) => x.toLowerCase()));
    const sales = await tx.select().from(shopSales).where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, toEx)));
    const cat = await tx.select({ key: stockCatalogue.key, cost: stockCatalogue.costPence }).from(stockCatalogue);
    const cost = new Map(cat.map((c) => [c.key, c.cost]));
    const [snap] = await tx.select().from(stockSnapshots).where(isNull(stockSnapshots.removedAt)).orderBy(desc(stockSnapshots.takenOn), desc(stockSnapshots.createdAt)).limit(1);
    const stock = snap ? await tx.select({ brand: stockItems.brand, qty: stockItems.quantity, cost: stockItems.costPence }).from(stockItems).where(eq(stockItems.snapshotId, snap.id)) : [];

    const groups = new Map<string, { name: string; brands: string[]; paid: number; sales: number; cogs: number; stock: number }>();
    for (const p of paid) {
      const s = supplierFor(p.description);
      if (!s) continue;
      const g = groups.get(s) ?? { name: s, brands: s.split(' & ').map((b) => b.toLowerCase()), paid: 0, sales: 0, cogs: 0, stock: 0 };
      g.paid += -p.amount;
      groups.set(s, g);
    }
    const groupOf = (brand: string) => [...groups.values()].find((g) => g.brands.includes(brand.toLowerCase()));
    for (const s of sales) {
      if (s.quantity <= 0) continue;
      const g = groupOf(s.brand);
      if (!g) continue;
      const credit = s.discounts.filter((d) => vouchers.has(d.name.toLowerCase())).reduce((n, d) => n + d.pence, 0);
      g.sales += s.unitPricePence * s.quantity - (s.discountPence - credit);
      const c = cost.get(s.key);
      g.cogs += (c ?? 0) * s.quantity;
    }
    for (const i of stock) {
      if (i.qty <= 0) continue;
      const g = groupOf(i.brand);
      if (g) g.stock += i.qty * (i.cost ?? 0);
    }
    const weeks = Math.max(1, Math.round((new Date(`${toEx}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / (7 * 86_400_000)));
    const rows = [...groups.values()]
      .map((g) => {
        const paidExVat = Math.round(g.paid / VAT);
        const building = paidExVat - g.cogs;
        const perPound = g.paid ? Math.round((g.sales / g.paid) * 100) / 100 : null;
        const note =
          g.cogs === 0 && g.paid > 0
            ? 'paid for stock, nothing sold yet in this period'
            : building > Math.max(50_000, g.cogs * 0.25)
              ? `buying faster than selling — about £${Math.round(building / 100).toLocaleString('en-GB')} more stock at cost`
              : building < -Math.max(50_000, g.cogs * 0.25)
                ? 'selling down stock — fewer re-orders than sales'
                : 'buying roughly what you sell';
        return { name: g.name, paid: g.paid, sales: g.sales, cogs: g.cogs, stock: g.stock, perPound, building, note };
      })
      .sort((a, b) => b.paid - a.paid);
    return { from, to: toEx, weeks, rows };
  });
}
