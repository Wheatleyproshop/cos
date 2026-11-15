import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { withTenant } from '@/db';
import { organisations, shopSales, stockCatalogue, stockItems, stockSnapshots } from '@/db/schema';
import { recordEvent } from '../../audit';
import { ServiceError, type Ctx } from '../common';

/**
 * Brand (and category) review from Shopify sales and the latest stock count.
 * - Selling prices include VAT; cost prices don't — so margin is worked out on prices less VAT (20%).
 * - Discounts the owner has marked as credit vouchers (e.g. CreditYard trade-in credit) are counted as
 *   money received, not as a price cut, so they don't make the margin look worse than it is.
 */

const VAT = 1.2;

export type Perf = {
  name: string; units: number; salesPence: number; reportedSalesPence: number; voucherPence: number; discountPence: number;
  costedSalesExVat: number; cogsPence: number; marginPct: number | null; reportedMarginPct: number | null;
  stockUnits: number; stockCostPence: number; sellThroughPct: number | null; weeksCover: number | null;
  verdict: 'star' | 'review' | 'watch' | null; reasons: string[];
};

export async function brandReview(orgId: string, from: string, to: string) {
  const days = Math.max(1, Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000));
  const weeks = days / 7;
  return withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ vouchers: organisations.voucherDiscounts }).from(organisations).limit(1);
    const vouchers = new Set((org?.vouchers ?? []).map((v) => v.toLowerCase()));
    const sales = await tx.select().from(shopSales).where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to)));
    const catalogue = await tx.select({ key: stockCatalogue.key, sku: stockCatalogue.sku, cost: stockCatalogue.costPence }).from(stockCatalogue);
    const costByKey = new Map(catalogue.map((c) => [c.key, c.cost]));
    const costBySku = new Map(catalogue.filter((c) => c.sku).map((c) => [c.sku.toLowerCase(), c.cost]));
    const [snap] = await tx.select().from(stockSnapshots).where(isNull(stockSnapshots.removedAt)).orderBy(desc(stockSnapshots.takenOn), desc(stockSnapshots.createdAt)).limit(1);
    const stock = snap ? await tx.select().from(stockItems).where(eq(stockItems.snapshotId, snap.id)) : [];

    // Every discount seen, so the owner can say which are vouchers.
    const discountNames = new Map<string, { name: string; lines: number; pence: number; voucher: boolean }>();
    type Acc = Omit<Perf, 'marginPct' | 'reportedMarginPct' | 'sellThroughPct' | 'weeksCover' | 'verdict' | 'reasons'> & { costedReportedExVat: number };
    const blank = (name: string): Acc => ({
      name, units: 0, salesPence: 0, reportedSalesPence: 0, voucherPence: 0, discountPence: 0, costedSalesExVat: 0, costedReportedExVat: 0, cogsPence: 0, stockUnits: 0, stockCostPence: 0,
    });
    const byBrand = new Map<string, Acc>();
    const byCat = new Map<string, Acc>();
    const get = (m: Map<string, Acc>, name: string) => {
      const k = (name || 'Unknown').toLowerCase();
      const a = m.get(k) ?? blank(name || 'Unknown');
      m.set(k, a);
      return a;
    };
    const totals = blank('All');
    for (const s of sales) {
      if (s.quantity <= 0) continue;
      const gross = s.unitPricePence * s.quantity;
      let voucher = 0;
      for (const d of s.discounts) {
        const isV = vouchers.has(d.name.toLowerCase());
        if (isV) voucher += d.pence;
        const n = discountNames.get(d.name.toLowerCase()) ?? { name: d.name, lines: 0, pence: 0, voucher: isV };
        n.lines += 1;
        n.pence += d.pence;
        discountNames.set(d.name.toLowerCase(), n);
      }
      const realDiscount = s.discountPence - voucher;
      const sold = gross - realDiscount; // vouchers count as money received
      const reported = gross - s.discountPence; // how it looks with vouchers as discounts
      const unitCost = costByKey.get(s.key) ?? (s.sku ? costBySku.get(s.sku.toLowerCase()) : null) ?? null;
      for (const a of [get(byBrand, s.brand), get(byCat, s.category), totals]) {
        a.units += s.quantity;
        a.salesPence += sold;
        a.reportedSalesPence += reported;
        a.voucherPence += voucher;
        a.discountPence += realDiscount;
        if (unitCost != null) {
          a.costedSalesExVat += sold / VAT;
          a.costedReportedExVat += reported / VAT;
          a.cogsPence += unitCost * s.quantity;
        }
      }
    }
    for (const i of stock) {
      if (i.quantity <= 0) continue;
      for (const a of [get(byBrand, i.brand), get(byCat, i.category), totals]) {
        a.stockUnits += i.quantity;
        a.stockCostPence += i.quantity * (i.costPence ?? 0);
      }
    }

    const finish = (a: Acc, medianSales: number): Perf => {
      const margin = a.costedSalesExVat > 0 ? Math.round(((a.costedSalesExVat - a.cogsPence) / a.costedSalesExVat) * 100) : null;
      const reportedMargin = a.costedReportedExVat > 0 ? Math.round(((a.costedReportedExVat - a.cogsPence) / a.costedReportedExVat) * 100) : null;
      const sellThrough = a.units + a.stockUnits > 0 ? Math.round((a.units / (a.units + a.stockUnits)) * 100) : null;
      const perWeek = a.units / weeks;
      const cover = a.stockUnits ? (perWeek > 0 ? Math.round(a.stockUnits / perWeek) : 999) : null;
      const reasons: string[] = [];
      let verdict: Perf['verdict'] = null;
      if (a.stockCostPence >= 100_000 && (cover === null ? false : cover > 26)) reasons.push(cover === 999 ? 'stock but no sales in this period' : `${cover} weeks of stock at the current rate of sale`);
      if (margin !== null && margin < 25 && a.salesPence > 50_000) reasons.push(`${margin}% margin`);
      if (sellThrough !== null && sellThrough < 20 && a.stockCostPence >= 100_000) reasons.push(`only ${sellThrough}% sell-through`);
      if (reasons.length) verdict = 'review';
      else if (a.salesPence >= medianSales && (margin ?? 0) >= 35 && cover !== null && cover <= 16) {
        verdict = 'star';
        reasons.push('sells well, healthy margin, stock turning');
      } else if (cover !== null && cover > 16 && cover <= 26 && a.stockCostPence >= 100_000) {
        verdict = 'watch';
        reasons.push(`${cover} weeks of stock`);
      }
      const { costedReportedExVat: _c, ...rest } = a;
      return { ...rest, marginPct: margin, reportedMarginPct: reportedMargin, sellThroughPct: sellThrough, weeksCover: cover, verdict, reasons };
    };
    const median = (m: Map<string, Acc>) => {
      const v = [...m.values()].map((a) => a.salesPence).filter((x) => x > 0).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    };
    const mb = median(byBrand);
    const mc = median(byCat);
    const order = (a: Perf, b: Perf) => b.salesPence - a.salesPence || b.stockCostPence - a.stockCostPence;
    return {
      from, to, weeks, snapTakenOn: snap?.takenOn ?? null, hasSales: sales.length > 0,
      totals: finish(totals, 0),
      brands: [...byBrand.values()].map((a) => finish(a, mb)).sort(order),
      categories: [...byCat.values()].map((a) => finish(a, mc)).sort(order),
      discounts: [...discountNames.values()].sort((a, b) => b.pence - a.pence).slice(0, 40),
    };
  });
}

/** Marks a Shopify discount name as a credit voucher (counted as payment) — or not. */
export async function setVoucherDiscount(ctx: Ctx, name: string, isVoucher: boolean) {
  const n = name.trim().toLowerCase().slice(0, 120);
  if (!n) throw new ServiceError('Pick a discount.');
  await withTenant(ctx.org.id, async (tx) => {
    const [org] = await tx.select({ v: organisations.voucherDiscounts }).from(organisations).where(eq(organisations.id, ctx.org.id)).limit(1);
    const before = org?.v ?? [];
    const next = isVoucher ? [...new Set([...before, n])] : before.filter((x) => x !== n);
    await tx.update(organisations).set({ voucherDiscounts: next }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { voucherDiscounts: before }, newValue: { voucherDiscounts: next }, metadata: { section: 'vouchers' },
    });
  });
}

/**
 * Each item sold for a brand (or category): full price, real discount, credit voucher used, the price it
 * actually sold for (what the shop received, counting credit as money), and margin on it.
 */
export async function salesLines(orgId: string, from: string, to: string, filter: { brand?: string; category?: string }) {
  return withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ vouchers: organisations.voucherDiscounts }).from(organisations).limit(1);
    const vouchers = new Set((org?.vouchers ?? []).map((v) => v.toLowerCase()));
    const rows = await tx
      .select()
      .from(shopSales)
      .where(and(gte(shopSales.soldOn, from), lt(shopSales.soldOn, to)))
      .orderBy(desc(shopSales.soldOn));
    const want = (r: (typeof rows)[number]) =>
      r.quantity > 0 &&
      (!filter.brand || r.brand.toLowerCase() === filter.brand.toLowerCase()) &&
      (!filter.category || r.category.toLowerCase() === filter.category.toLowerCase());
    const picked = rows.filter(want).slice(0, 400);
    const keys = [...new Set(picked.map((r) => r.key).filter(Boolean))];
    const costs = keys.length
      ? await tx.select({ key: stockCatalogue.key, cost: stockCatalogue.costPence }).from(stockCatalogue).where(inArray(stockCatalogue.key, keys))
      : [];
    const costByKey = new Map(costs.map((c) => [c.key, c.cost]));
    return picked.map((r) => {
      const full = r.unitPricePence * r.quantity;
      const credit = r.discounts.filter((d) => vouchers.has(d.name.toLowerCase())).reduce((n, d) => n + d.pence, 0);
      const discount = r.discountPence - credit;
      const soldFor = full - discount;
      const cost = costByKey.get(r.key) ?? null;
      const exVat = soldFor / VAT;
      return {
        id: r.id, soldOn: r.soldOn, orderName: r.orderName, channel: r.channel, title: r.title, quantity: r.quantity,
        fullPence: full, discountPence: discount, creditPence: credit, soldForPence: soldFor, paidOtherwisePence: soldFor - credit,
        discountNames: r.discounts.filter((d) => !vouchers.has(d.name.toLowerCase())).map((d) => d.name),
        marginPct: cost != null && exVat > 0 ? Math.round(((exVat - cost * r.quantity) / exVat) * 100) : null,
      };
    });
  });
}
