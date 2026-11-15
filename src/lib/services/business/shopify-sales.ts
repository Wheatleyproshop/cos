import { eq, sql } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { organisations, shopSales, type Organisation } from '@/db/schema';
import { recordEvent, SYSTEM, type Actor } from '../../audit';
import { shopifyConfig, ShopifyError, shopifyGraphql } from '../../shopify';
import { categoryFor, cleanBrand, keyFor } from '../../stock-csv';

/**
 * Shopify sales (online and POS) pulled into COS with a bulk export: the first run fetches the last
 * 12 months, then each run fetches orders changed since the last one (so refunds are picked up).
 * A big export can take longer than one run; it carries on next time.
 */

const FIRST_RUN_DAYS = 365;
const OVERLAP_MS = 2 * 86_400_000;

const bulkQuery = (since: string) => `{
  orders(query: "updated_at:>='${since}'") {
    edges { node {
      id name processedAt sourceName cancelledAt test
      lineItems { edges { node {
        id sku name vendor quantity currentQuantity
        originalUnitPriceSet { shopMoney { amount } }
        variant { selectedOptions { value } }
        product { handle productType title category { name } }
        discountAllocations {
          allocatedAmountSet { shopMoney { amount } }
          discountApplication {
            __typename
            ... on DiscountCodeApplication { code }
            ... on ManualDiscountApplication { title }
            ... on AutomaticDiscountApplication { title }
            ... on ScriptDiscountApplication { title }
          }
        }
      } } }
    } }
  }
}`;

type BulkLine = {
  id: string; __parentId?: string; name?: string; processedAt?: string; sourceName?: string | null; cancelledAt?: string | null; test?: boolean;
  sku?: string | null; vendor?: string | null; quantity?: number; currentQuantity?: number;
  originalUnitPriceSet?: { shopMoney: { amount: string } };
  variant?: { selectedOptions: { value: string }[] } | null;
  product?: { handle: string; productType: string; title: string; category: { name: string } | null } | null;
  discountAllocations?: { allocatedAmountSet: { shopMoney: { amount: string } }; discountApplication: { __typename: string; code?: string; title?: string } }[];
};

const pence = (v: string | undefined) => Math.round(Number(v ?? 0) * 100);

async function saveState(orgId: string, state: Organisation['shopifySync']) {
  await withTenant(orgId, (tx) => tx.update(organisations).set({ shopifySync: state }).where(eq(organisations.id, orgId)));
}

/** Turns the export file into sales rows and saves them (updating lines seen before). */
export async function importBulkFile(org: Organisation, jsonl: string, tz: string) {
  const ordersById = new Map<string, BulkLine>();
  const lines: BulkLine[] = [];
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    const o = JSON.parse(raw) as BulkLine;
    if (o.id.includes('/Order/')) ordersById.set(o.id, o);
    else if (o.id.includes('/LineItem/')) lines.push(o);
  }
  const rows: (typeof shopSales.$inferInsert)[] = [];
  for (const l of lines) {
    const order = l.__parentId ? ordersById.get(l.__parentId) : undefined;
    if (!order || order.test) continue;
    const handle = l.product?.handle ?? '';
    const opts = (l.variant?.selectedOptions ?? []).map((o) => o.value).slice(0, 3);
    const brand = cleanBrand(l.vendor ?? '');
    const qty = order.cancelledAt ? 0 : (l.currentQuantity ?? l.quantity ?? 0);
    const discounts = (l.discountAllocations ?? [])
      .map((d) => ({ name: (d.discountApplication.code ?? d.discountApplication.title ?? d.discountApplication.__typename).trim(), pence: pence(d.allocatedAmountSet.shopMoney.amount) }))
      .filter((d) => d.pence > 0);
    // Discounts are on the original quantity: scale them down when some of the line was refunded.
    const scale = l.quantity ? qty / l.quantity : 0;
    const scaled = discounts.map((d) => ({ ...d, pence: Math.round(d.pence * scale) }));
    rows.push({
      organisationId: org.id, lineId: l.id, orderId: order.id, orderName: order.name ?? '',
      soldOn: new Date(order.processedAt ?? Date.now()).toLocaleDateString('en-CA', { timeZone: tz }),
      channel: order.sourceName === 'pos' ? 'In store' : 'Online',
      key: handle ? keyFor(handle, opts) : '', sku: l.sku ?? '', title: l.product?.title ?? l.name ?? 'Item', brand,
      category: categoryFor(l.product?.productType ?? '', l.product?.category?.name ?? '', l.product?.title ?? l.name ?? '', brand),
      quantity: qty, unitPricePence: pence(l.originalUnitPriceSet?.shopMoney.amount), discounts: scaled, discountPence: scaled.reduce((n, d) => n + d.pence, 0),
    });
  }
  await withTenant(org.id, async (tx) => {
    for (let i = 0; i < rows.length; i += 300) {
      await tx
        .insert(shopSales)
        .values(rows.slice(i, i + 300))
        .onConflictDoUpdate({
          target: [shopSales.organisationId, shopSales.lineId],
          set: {
            quantity: sql`excluded.quantity`, discounts: sql`excluded.discounts`, discountPence: sql`excluded.discount_pence`, soldOn: sql`excluded.sold_on`,
            brand: sql`excluded.brand`, category: sql`excluded.category`, title: sql`excluded.title`, updatedAt: sql`now()`,
          },
        });
    }
  });
  return { orders: ordersById.size, lines: rows.length };
}

type BulkOp = { id: string; status: string; errorCode: string | null; url: string | null; objectCount: string };

/** Starts (or carries on with) the sales export. Waits up to `waitMs` for Shopify to finish preparing it. */
export async function syncShopifySales(opts: { actor?: Actor; waitMs?: number } = {}) {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t connected yet.');
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, cfg.orgSlug)).limit(1);
  if (!org) throw new ShopifyError(`No COS shop called “${cfg.orgSlug}”.`);
  const state = { ...org.shopifySync };
  const started = Date.now();
  let bulkId = state.bulkId;
  let since = state.bulkSince;
  // When the export now being collected was asked for (orders changed after that are fetched next time).
  let exportStartedAt = state.bulkId && state.lastRunAt ? state.lastRunAt : new Date(started).toISOString();
  if (!bulkId) {
    since = state.ordersSince
      ? new Date(new Date(state.ordersSince).getTime() - OVERLAP_MS).toISOString()
      : new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
    const res: { bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: { message: string }[] } } = await shopifyGraphql(
      `mutation Run($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
      { q: bulkQuery(since.slice(0, 19) + 'Z') },
    );
    const err = res.bulkOperationRunQuery.userErrors[0]?.message;
    if (err) {
      if (/access denied|scope|read_orders/i.test(err)) throw new ShopifyError('The Shopify app needs permission to read orders (read_orders, and read_all_orders for more than 60 days of history).');
      throw new ShopifyError(err);
    }
    bulkId = res.bulkOperationRunQuery.bulkOperation!.id;
    exportStartedAt = new Date(started).toISOString();
    await saveState(org.id, { ...state, bulkId, bulkSince: since, lastRunAt: exportStartedAt });
  }
  // Wait for Shopify to prepare the file.
  let op: BulkOp | null = null;
  for (;;) {
    const r: { node: BulkOp | null } = await shopifyGraphql(`query Op($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode url objectCount } } }`, { id: bulkId });
    op = r.node;
    if (!op || ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) break;
    if (Date.now() - started > (opts.waitMs ?? 200_000)) {
      return { status: 'running' as const, message: 'Shopify is still preparing the sales export — it will finish on the next sync.' };
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  if (!op || op.status !== 'COMPLETED') {
    await saveState(org.id, { ...state, bulkId: undefined, bulkSince: undefined, lastError: `Export ${op?.status ?? 'missing'} ${op?.errorCode ?? ''}`.trim() });
    throw new ShopifyError(`Shopify couldn’t prepare the sales export (${op?.errorCode ?? op?.status ?? 'unknown'}). It will try again next time.`);
  }
  let result = { orders: 0, lines: 0 };
  if (op.url) {
    const file = await fetch(op.url, { signal: AbortSignal.timeout(120_000) });
    if (!file.ok) throw new ShopifyError('Couldn’t download the sales export from Shopify.');
    result = await importBulkFile(org, await file.text(), org.timezone);
  }
  // Next time: orders changed since this export started (with a little overlap).
  await saveState(org.id, { ordersSince: exportStartedAt, lastRunAt: new Date().toISOString() });
  await withTenant(org.id, (tx) =>
    recordEvent(tx, {
      organisationId: org.id, actor: opts.actor ?? SYSTEM, eventType: 'stock_uploaded', entityType: 'organisation', entityId: org.id,
      metadata: { kind: 'shopify_sales', since, ...result },
    }),
  );
  return { status: 'done' as const, ...result, since };
}
