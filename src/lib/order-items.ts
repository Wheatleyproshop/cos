/**
 * Several items on one order or quote. The first item is the form's normal product fields; any
 * others arrive as `extraItems` (JSON). They're folded into the order: a numbered list in the
 * specification (what staff, emails and the tracking page show), the summed total, a short product
 * summary ("Victory Polo (+2 more)") and the structured list in `specificationJson`.
 */
import { z } from 'zod';
import { money as fmt } from './format';
import { composeSpec } from './order-details';

/** Each item on a multi-item order moves on its own. */
export const ITEM_STATUSES = ['to_order', 'ordered', 'delayed', 'arrived', 'collected'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  to_order: 'To order', ordered: 'Ordered', delayed: 'Out of stock', arrived: 'Arrived', collected: 'Collected',
};
/** What the customer sees on their tracking page. */
export const ITEM_STATUS_CUSTOMER: Record<ItemStatus, string> = {
  to_order: 'Being ordered', ordered: 'On order', delayed: 'Delayed at the supplier', arrived: 'In the shop', collected: 'Collected',
};

export type OrderItem = {
  brand: string; category: string; product: string; variant: string; colour: string; size: string; hand: string; sku: string;
  quantity: number; unitPricePence: number; linePence: number; notes: string;
  status?: ItemStatus; etaDate?: string | null; supplierReference?: string;
};

export function asItemsSpec(json: unknown): ItemsSpec | null {
  const s = json as ItemsSpec | null;
  return s && typeof s === 'object' && s.kind === 'cos-items' && Array.isArray(s.items) && s.items.length > 0 ? s : null;
}

export const itemStatus = (it: OrderItem): ItemStatus => it.status ?? 'to_order';

/** "2 of 3 arrived" for the order pad. Collected counts as arrived. */
export function itemsProgress(json: unknown): { total: number; arrived: number; collected: number; delayed: number } | null {
  const s = asItemsSpec(json);
  if (!s) return null;
  const st = s.items.map(itemStatus);
  return {
    total: st.length,
    arrived: st.filter((x) => x === 'arrived' || x === 'collected').length,
    collected: st.filter((x) => x === 'collected').length,
    delayed: st.filter((x) => x === 'delayed').length,
  };
}
export type ItemsSpec = { kind: 'cos-items'; version: 1; items: OrderItem[] };

const t = (n: number) => z.string().trim().max(n).default('');
const extraItemSchema = z.object({
  brand: z.string().trim().min(1, 'Brand is required').max(80),
  category: t(40),
  product: z.string().trim().min(1, 'Product is required').max(160),
  variant: t(120), colour: t(60), size: t(40), hand: t(20), sku: t(80), notes: t(1000),
  quantity: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(999).default(1),
  unitPricePence: z.string().trim(),
});

export class ItemsError extends Error {}

/** Returns the raw form values unchanged when there's only one item. */
export function combineItems(raw: unknown, parseMoney: (v: string) => number | null): { raw: unknown; spec: ItemsSpec | null } {
  const r = (raw ?? {}) as Record<string, unknown>;
  let extras: unknown[] = [];
  try {
    extras = r.extraItems ? JSON.parse(String(r.extraItems)) : [];
  } catch {
    throw new ItemsError('The extra items could not be read. Please try again.');
  }
  if (!Array.isArray(extras) || extras.length === 0) return { raw, spec: null };
  if (extras.length > 30) throw new ItemsError('Up to 31 items per order.');

  const str = (k: string) => String(r[k] ?? '').trim();
  const firstQty = Math.max(1, Math.floor(Number(r.quantity) || 1));
  const firstUnit = parseMoney(str('unitPricePence') || '');
  if (firstUnit === null || firstUnit < 0) throw new ItemsError('Item 1: enter the price each.');
  const items: OrderItem[] = [
    {
      brand: str('brand'), category: str('category'), product: str('product'), variant: str('variant'), colour: str('colour'), size: str('size'),
      hand: str('hand'), sku: str('sku'), quantity: firstQty, unitPricePence: firstUnit, linePence: firstUnit * firstQty, notes: '',
    },
  ];
  extras.forEach((e, i) => {
    const res = extraItemSchema.safeParse(e);
    if (!res.success) throw new ItemsError(`Item ${i + 2}: ${res.error.issues[0]?.message ?? 'check the details'}`);
    const unit = parseMoney(res.data.unitPricePence || '');
    if (unit === null || unit < 0) throw new ItemsError(`Item ${i + 2}: enter the price each.`);
    const { unitPricePence: _u, ...rest } = res.data;
    items.push({ ...rest, unitPricePence: unit, linePence: unit * rest.quantity });
  });

  const total = items.reduce((n, it) => n + it.linePence, 0);
  const lines = items.map((it, i) => {
    const detail = composeSpec({ variant: it.variant, colour: it.colour, size: it.size, hand: it.hand })
      .split('\n')
      .filter(Boolean)
      .map((l) => `   ${l}`);
    const price = it.quantity > 1 ? `${it.quantity} × ${fmt(it.unitPricePence)} = ${fmt(it.linePence)}` : fmt(it.linePence);
    return [
      `${i + 1}. ${it.brand} ${it.product} · ${price}`,
      ...detail,
      ...(it.sku ? [`   Product ID: ${it.sku}`] : []),
      ...(it.notes ? [`   ${it.notes}`] : []),
    ].join('\n');
  });
  const notes = str('specificationText');
  const summary = `${items[0].product} (+${items.length - 1} more)`;
  return {
    raw: {
      ...r,
      product: summary.length <= 160 ? summary : `${items[0].product.slice(0, 140)}… (+${items.length - 1} more)`,
      variant: '', colour: '', size: '', hand: '', quantity: '1', unitPricePence: '',
      specificationText: [`${items.length} items:`, lines.join('\n'), notes].filter(Boolean).join('\n\n'),
      totalGrossPence: (total / 100).toFixed(2),
    },
    spec: { kind: 'cos-items', version: 1, items },
  };
}
