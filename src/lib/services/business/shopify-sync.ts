import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { organisations, stockCatalogue, stockItems, stockSnapshots, users } from '@/db/schema';
import { recordEvent, SYSTEM, type Actor } from '../../audit';
import { todayInTz } from '../../format';
import { shopifyConfig, ShopifyError, shopifyGraphql } from '../../shopify';
import { categoryFor, cleanBrand, keyFor, variantName } from '../../stock-csv';

/**
 * Nightly (and on-demand) stock sync from Shopify: refreshes the product list (cost, price, brand,
 * type) and records today's stock count. Read-only on the Shopify side.
 */

export const SHOPIFY_SNAPSHOT_NAME = 'Shopify (automatic)';

const QUERY = `query Variants($cursor: String) {
  productVariants(first: 150, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      sku
      price
      inventoryQuantity
      selectedOptions { value }
      inventoryItem { tracked unitCost { amount } }
      product { handle title vendor productType category { name } }
    }
  }
}`;

type Variant = {
  sku: string | null; price: string | null; inventoryQuantity: number | null; selectedOptions: { value: string }[];
  inventoryItem: { tracked: boolean; unitCost: { amount: string } | null } | null;
  product: { handle: string; title: string; vendor: string; productType: string; category: { name: string } | null };
};

const toPence = (v: string | null | undefined) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

export async function syncShopifyStock(opts: { actor?: Actor; userId?: string } = {}) {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t connected yet.');
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, cfg.orgSlug)).limit(1);
  if (!org) throw new ShopifyError(`No COS shop called “${cfg.orgSlug}”.`);

  // 1. Every variant, page by page.
  const variants: Variant[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 400; page++) {
    const data: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Variant[] } } = await shopifyGraphql(QUERY, { cursor });
    variants.push(...data.productVariants.nodes);
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }

  const rows = variants.map((v) => {
    const opts = v.selectedOptions.map((o) => o.value).slice(0, 3);
    const brand = cleanBrand(v.product.vendor);
    return {
      key: keyFor(v.product.handle, opts), sku: v.sku ?? '', title: v.product.title, variant: variantName(opts), brand,
      category: categoryFor(v.product.productType, v.product.category?.name ?? '', v.product.title, brand),
      costPence: toPence(v.inventoryItem?.unitCost?.amount), pricePence: toPence(v.price),
      quantity: v.inventoryItem?.tracked === false ? 0 : (v.inventoryQuantity ?? 0),
    };
  });
  // The same variant can't appear twice; keep the first if Shopify ever returns a duplicate key.
  const unique = [...new Map(rows.map((r) => [r.key, r])).values()];
  const today = todayInTz(org.timezone);
  const actor = opts.actor ?? SYSTEM;
  // Snapshots belong to someone: the person who pressed Sync, or the shop owner for the nightly run.
  const ownerId =
    opts.userId ??
    (await withTenant(org.id, (tx) => tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.active, true))).orderBy(users.createdAt).limit(1)))[0]?.id;
  if (!ownerId) throw new ShopifyError('No owner account to record the stock count against.');

  return withTenant(org.id, async (tx) => {
    for (let i = 0; i < unique.length; i += 400) {
      await tx
        .insert(stockCatalogue)
        .values(unique.slice(i, i + 400).map(({ quantity: _q, ...r }) => ({ organisationId: org.id, ...r })))
        .onConflictDoUpdate({
          target: [stockCatalogue.organisationId, stockCatalogue.key],
          set: {
            sku: sql`excluded.sku`, title: sql`excluded.title`, variant: sql`excluded.variant`, brand: sql`excluded.brand`, category: sql`excluded.category`,
            costPence: sql`excluded.cost_pence`, pricePence: sql`excluded.price_pence`, updatedAt: sql`now()`,
          },
        });
    }
    // One automatic count per day: today's earlier sync (if any) is replaced.
    const earlier = await tx
      .select({ id: stockSnapshots.id })
      .from(stockSnapshots)
      .where(and(eq(stockSnapshots.fileName, SHOPIFY_SNAPSHOT_NAME), eq(stockSnapshots.takenOn, today), isNull(stockSnapshots.removedAt)));
    if (earlier.length) {
      const ids = earlier.map((e) => e.id);
      await tx.delete(stockItems).where(inArray(stockItems.snapshotId, ids));
      await tx.update(stockSnapshots).set({ removedAt: new Date() }).where(inArray(stockSnapshots.id, ids));
    }
    const held = unique.filter((r) => r.quantity !== 0);
    const [snap] = await tx
      .insert(stockSnapshots)
      .values({ organisationId: org.id, takenOn: today, fileName: SHOPIFY_SNAPSHOT_NAME, location: 'All Shopify locations', lines: held.length, unmatched: held.filter((r) => r.costPence == null).length, uploadedByUserId: ownerId })
      .returning();
    for (let i = 0; i < held.length; i += 400) {
      await tx.insert(stockItems).values(held.slice(i, i + 400).map((r) => ({ organisationId: org.id, snapshotId: snap.id, ...r })));
    }
    // Keep daily counts for 60 days, then one a week (Mondays) so the history stays useful but small.
    const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const old = await tx
      .select({ id: stockSnapshots.id })
      .from(stockSnapshots)
      .where(and(eq(stockSnapshots.fileName, SHOPIFY_SNAPSHOT_NAME), lt(stockSnapshots.takenOn, cutoff), isNull(stockSnapshots.removedAt), sql`extract(isodow from ${stockSnapshots.takenOn}) <> 1`));
    if (old.length) {
      const ids = old.map((o) => o.id);
      await tx.delete(stockItems).where(inArray(stockItems.snapshotId, ids));
      await tx.update(stockSnapshots).set({ removedAt: new Date() }).where(inArray(stockSnapshots.id, ids));
    }
    const units = held.reduce((n, r) => n + Math.max(0, r.quantity), 0);
    await recordEvent(tx, {
      organisationId: org.id, actor, eventType: 'stock_uploaded', entityType: 'organisation', entityId: org.id,
      metadata: { kind: 'shopify', variants: unique.length, lines: held.length, units, snapshotId: snap.id },
    });
    return { variants: unique.length, lines: held.length, units, noCost: held.filter((r) => r.costPence == null).length };
  });
}

/** For the Stock page: connected?, and when it last synced. */
export async function shopifyStatus(orgId: string) {
  const cfg = shopifyConfig();
  const [last] = await withTenant(orgId, (tx) =>
    tx
      .select({ takenOn: stockSnapshots.takenOn, createdAt: stockSnapshots.createdAt, lines: stockSnapshots.lines })
      .from(stockSnapshots)
      .where(and(eq(stockSnapshots.fileName, SHOPIFY_SNAPSHOT_NAME), isNull(stockSnapshots.removedAt)))
      .orderBy(sql`${stockSnapshots.createdAt} desc`)
      .limit(1),
  );
  return { connected: Boolean(cfg), shop: cfg?.shop ?? null, last: last ?? null };
}
