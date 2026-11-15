import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { orders, prebookLines, prebooks, stockCatalogue, stockItems, stockSnapshots } from '@/db/schema';
import { recordEvent } from '../../audit';
import { asItemsSpec, itemStatus } from '../../order-items';
import { cleanBrand, guessCategory, parseStockCsv, StockCsvError, type CatalogueRow } from '../../stock-csv';
import { ServiceError, type Ctx } from '../common';

/**
 * Stock held (from uploaded exports) and money committed to future stock (pre-books, and supplier
 * orders for customers), by brand, category and month.
 */

const BATCH = 400;

export async function importStockFile(ctx: Ctx, file: File, takenOn: string) {
  if (!ctx.userId) throw new ServiceError('Sign in again.');
  if (file.size > 25 * 1024 * 1024) throw new ServiceError('That file is too big (25 MB maximum).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(takenOn)) throw new ServiceError('Pick the date the stock was counted.', { takenOn: 'Pick a date' });
  let parsed;
  try {
    parsed = parseStockCsv(await file.text());
  } catch (e) {
    if (e instanceof StockCsvError) throw new ServiceError(e.message);
    throw e;
  }
  if (parsed.kind === 'catalogue') {
    const rows = parsed.rows;
    await withTenant(ctx.org.id, async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        await tx
          .insert(stockCatalogue)
          .values(rows.slice(i, i + BATCH).map((r) => ({ organisationId: ctx.org.id, ...r })))
          .onConflictDoUpdate({
            target: [stockCatalogue.organisationId, stockCatalogue.key],
            set: {
              sku: sql`excluded.sku`, title: sql`excluded.title`, variant: sql`excluded.variant`, brand: sql`excluded.brand`, category: sql`excluded.category`,
              costPence: sql`excluded.cost_pence`, pricePence: sql`excluded.price_pence`, updatedAt: sql`now()`,
            },
          });
      }
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'stock_uploaded', entityType: 'organisation', entityId: ctx.org.id,
        metadata: { kind: 'catalogue', file: file.name, rows: rows.length },
      });
    });
    return { kind: 'catalogue' as const, rows: rows.length, withCost: rows.filter((r) => r.costPence).length };
  }

  const rows = parsed.rows;
  return withTenant(ctx.org.id, async (tx) => {
    // Match each quantity to the catalogue by Shopify handle + options, or SKU.
    const keys = rows.map((r) => r.key);
    const skus = rows.map((r) => r.sku).filter(Boolean);
    const byKey = new Map<string, CatalogueRow>();
    const bySku = new Map<string, CatalogueRow>();
    for (let i = 0; i < keys.length; i += BATCH) {
      const found = await tx.select().from(stockCatalogue).where(inArray(stockCatalogue.key, keys.slice(i, i + BATCH)));
      for (const c of found) byKey.set(c.key, c);
    }
    for (let i = 0; i < skus.length; i += BATCH) {
      const found = await tx.select().from(stockCatalogue).where(inArray(stockCatalogue.sku, skus.slice(i, i + BATCH)));
      for (const c of found) if (c.sku) bySku.set(c.sku.toLowerCase(), c);
    }
    let unmatched = 0;
    const items = rows.map((r) => {
      const c = byKey.get(r.key) ?? (r.sku ? bySku.get(r.sku.toLowerCase()) : undefined);
      if (!c && r.costPence == null) unmatched++;
      return {
        key: r.key, sku: r.sku || c?.sku || '', title: c?.title ?? r.title, variant: c?.variant ?? r.variant,
        brand: r.brand || c?.brand || '', category: r.category || c?.category || guessCategory(r.title),
        quantity: r.quantity, costPence: r.costPence ?? c?.costPence ?? null, pricePence: r.pricePence ?? c?.pricePence ?? null,
      };
    });
    const [snap] = await tx
      .insert(stockSnapshots)
      .values({ organisationId: ctx.org.id, takenOn, fileName: file.name.slice(0, 120), location: parsed.locations.join(', ').slice(0, 200), lines: items.length, unmatched, uploadedByUserId: ctx.userId! })
      .returning();
    for (let i = 0; i < items.length; i += BATCH) {
      await tx.insert(stockItems).values(items.slice(i, i + BATCH).map((it) => ({ organisationId: ctx.org.id, snapshotId: snap.id, ...it })));
    }
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'stock_uploaded', entityType: 'organisation', entityId: ctx.org.id,
      metadata: { kind: 'stock', file: file.name, lines: items.length, unmatched, snapshotId: snap.id },
    });
    return { kind: 'stock' as const, lines: items.length, unmatched, units: items.reduce((n, x) => n + Math.max(0, x.quantity), 0) };
  });
}

export async function removeStockSnapshot(ctx: Ctx, id: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [s] = await tx.select().from(stockSnapshots).where(eq(stockSnapshots.id, id)).limit(1);
    if (!s || s.removedAt) return;
    await tx.update(stockSnapshots).set({ removedAt: new Date() }).where(eq(stockSnapshots.id, id));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'stock_uploaded', entityType: 'organisation', entityId: ctx.org.id, metadata: { removed: id, file: s.fileName } });
  });
}

export type Breakdown = { name: string; units: number; costPence: number; retailPence: number; lines: number };

function breakdown<T>(rows: T[], key: (r: T) => string, units: (r: T) => number, cost: (r: T) => number, retail: (r: T) => number): Breakdown[] {
  const m = new Map<string, Breakdown>();
  for (const r of rows) {
    const name = key(r) || 'Unknown';
    const k = name.toLowerCase();
    const g = m.get(k) ?? { name, units: 0, costPence: 0, retailPence: 0, lines: 0 };
    g.units += units(r);
    g.costPence += cost(r);
    g.retailPence += retail(r);
    g.lines += 1;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.costPence - a.costPence || b.retailPence - a.retailPence);
}

/** The latest stock count, broken down, compared with the one before. */
export async function stockReport(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const snaps = await tx.select().from(stockSnapshots).where(isNull(stockSnapshots.removedAt)).orderBy(desc(stockSnapshots.takenOn), desc(stockSnapshots.createdAt)).limit(24);
    const catalogue = await tx.select({ n: sql<number>`count(*)::int`, updated: sql<Date | null>`max(${stockCatalogue.updatedAt})` }).from(stockCatalogue);
    if (!snaps.length) return { snaps, catalogue: catalogue[0], latest: null };
    const items = await tx.select().from(stockItems).where(eq(stockItems.snapshotId, snaps[0].id));
    const held = items.filter((i) => i.quantity > 0);
    const cost = (i: (typeof items)[number]) => i.quantity * (i.costPence ?? 0);
    const retail = (i: (typeof items)[number]) => i.quantity * (i.pricePence ?? 0);
    const prevItems = snaps[1] ? await tx.select().from(stockItems).where(eq(stockItems.snapshotId, snaps[1].id)) : [];
    const prevByBrand = new Map(breakdown(prevItems.filter((i) => i.quantity > 0), (i) => i.brand, (i) => i.quantity, cost, retail).map((b) => [b.name.toLowerCase(), b]));
    return {
      snaps,
      catalogue: catalogue[0],
      latest: {
        snap: snaps[0],
        prev: snaps[1] ?? null,
        units: held.reduce((n, i) => n + i.quantity, 0),
        costPence: held.reduce((n, i) => n + cost(i), 0),
        retailPence: held.reduce((n, i) => n + retail(i), 0),
        prevCostPence: prevItems.filter((i) => i.quantity > 0).reduce((n, i) => n + cost(i), 0),
        lines: held.length,
        noCost: held.filter((i) => i.costPence == null).length,
        noCostUnits: held.filter((i) => i.costPence == null).reduce((n, i) => n + i.quantity, 0),
        negative: items.filter((i) => i.quantity < 0).length,
        byBrand: breakdown(held, (i) => i.brand, (i) => i.quantity, cost, retail).map((b) => ({ ...b, prevCostPence: prevByBrand.get(b.name.toLowerCase())?.costPence ?? null })),
        byCategory: breakdown(held, (i) => i.category, (i) => i.quantity, cost, retail),
        top: [...held].sort((a, b) => cost(b) - cost(a)).slice(0, 15),
      },
    };
  });
}

/**
 * Money committed to stock that hasn't arrived: pre-book lines still to come (at cost), and customer
 * orders on order with suppliers (at the customer's price — already sold).
 */
export async function commitments(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const lines = await tx
      .select({ l: prebookLines, p: prebooks })
      .from(prebookLines)
      .innerJoin(prebooks, eq(prebooks.id, prebookLines.prebookId))
      .where(and(isNull(prebookLines.removedAt), isNull(prebooks.removedAt), isNull(prebooks.archivedAt), notInArray(prebooks.status, ['cancelled', 'delivered'])));
    const skus = [...new Set(lines.map((x) => x.l.sku).filter(Boolean))];
    const cat = skus.length ? await tx.select({ sku: stockCatalogue.sku, category: stockCatalogue.category }).from(stockCatalogue).where(inArray(stockCatalogue.sku, skus)) : [];
    const catBySku = new Map(cat.map((c) => [c.sku.toLowerCase(), c.category]));
    const due = lines
      .map(({ l, p }) => ({
        brand: cleanBrand(p.brand), category: (l.sku && catBySku.get(l.sku.toLowerCase())) || guessCategory(`${l.product} ${p.title}`),
        units: Math.max(0, l.quantity - l.quantityReceived), costPence: Math.max(0, l.quantity - l.quantityReceived) * l.unitCostPence,
        month: (l.expectedDate ?? p.expectedFrom ?? p.expectedTo ?? '').slice(0, 7), draft: p.status === 'draft', forCustomer: Boolean(l.forCustomer),
      }))
      .filter((x) => x.units > 0);
    const placed = due.filter((x) => !x.draft);
    const months = new Map<string, { month: string; costPence: number; units: number }>();
    for (const x of placed) {
      const k = x.month || 'No date';
      const g = months.get(k) ?? { month: k, costPence: 0, units: 0 };
      g.costPence += x.costPence;
      g.units += x.units;
      months.set(k, g);
    }
    // Customer orders already placed with suppliers (sold, awaiting delivery).
    const open = await tx
      .select({ brand: orders.brand, product: orders.product, status: orders.status, total: orders.totalGrossPence, spec: orders.specificationJson })
      .from(orders)
      .where(and(inArray(orders.status, ['place_order', 'ordered', 'delayed']), isNull(orders.archivedAt), isNull(orders.removedAt)));
    const customer: { brand: string; pricePence: number; placed: boolean }[] = [];
    for (const o of open) {
      const items = asItemsSpec(o.spec);
      if (items) for (const it of items.items) customer.push({ brand: cleanBrand(it.brand), pricePence: it.linePence, placed: ['ordered', 'delayed'].includes(itemStatus(it)) });
      else customer.push({ brand: cleanBrand(o.brand), pricePence: o.total, placed: o.status !== 'place_order' });
    }
    const sumBy = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
      const m = new Map<string, { name: string; pence: number; n: number }>();
      for (const r of rows) {
        const name = key(r) || 'Unknown';
        const g = m.get(name.toLowerCase()) ?? { name, pence: 0, n: 0 };
        g.pence += val(r);
        g.n += 1;
        m.set(name.toLowerCase(), g);
      }
      return [...m.values()].sort((a, b) => b.pence - a.pence);
    };
    return {
      prebookCostPence: placed.reduce((n, x) => n + x.costPence, 0),
      prebookUnits: placed.reduce((n, x) => n + x.units, 0),
      draftCostPence: due.filter((x) => x.draft).reduce((n, x) => n + x.costPence, 0),
      byBrand: sumBy(placed, (x) => x.brand, (x) => x.costPence),
      byCategory: sumBy(placed, (x) => x.category, (x) => x.costPence),
      byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      customerOrders: { placedPence: customer.filter((c) => c.placed).reduce((n, c) => n + c.pricePence, 0), toPlacePence: customer.filter((c) => !c.placed).reduce((n, c) => n + c.pricePence, 0), byBrand: sumBy(customer, (c) => c.brand, (c) => c.pricePence) },
    };
  });
}
