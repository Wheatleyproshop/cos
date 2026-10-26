/** Product details captured when taking an order or quote. Client-safe (used by the form too). */

export const ORDER_CATEGORIES = [
  'Clubs', 'Putter', 'Golf balls', 'Bag', 'Trolley', 'Shoes', 'Clothing', 'Waterproofs', 'Gloves', 'Headwear',
  'Technology', 'Accessories', 'Other',
] as const;

/** Brands offered even before they appear in the catalogue, accounts or past orders. */
export const DEFAULT_BRANDS = [
  'adidas', 'Bridgestone', 'Bushnell', 'Callaway', 'Cleveland', 'Cobra', 'Ecco', 'FootJoy', 'Galvin Green', 'Garmin', 'Golf Pride',
  'Mizuno', 'Motocaddy', 'Nike', 'Ogio', 'PING', 'PowaKaddy', 'Puma', 'Shot Scope', 'Srixon', 'Sun Mountain', 'TaylorMade',
  'Titleist', 'Under Armour', 'Wilson',
];

export const HANDS = ['', 'Right-handed', 'Left-handed'] as const;

export type OrderDetails = { variant?: string; colour?: string; size?: string; hand?: string; quantity?: number | null; unitPricePence?: number | null; notes?: string };

/** One line per detail, then any free-text specification: what staff, emails and the customer see. */
export function composeSpec(d: OrderDetails): string {
  const lines = [
    d.variant ? `Model / variant: ${d.variant}` : '',
    d.colour ? `Colour: ${d.colour}` : '',
    d.size ? `Size: ${d.size}` : '',
    d.hand ? `Hand: ${d.hand}` : '',
    d.quantity && d.quantity > 1 ? `Quantity: ${d.quantity}${d.unitPricePence ? ` × ${(d.unitPricePence / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} each` : ''}` : '',
  ].filter(Boolean);
  return [lines.join('\n'), (d.notes ?? '').trim()].filter(Boolean).join('\n\n');
}

/** Case-insensitive merge, first spelling wins, sorted A–Z. */
export function mergeBrands(...lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) for (const b of list) {
    const t = b.trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * If the form sent a price each, the total is price each × quantity (the server's figure wins over
 * whatever the browser worked out).
 */
export function withUnitTotal(raw: unknown, parseMoney: (v: string) => number | null): unknown {
  const r = (raw ?? {}) as Record<string, unknown>;
  const each = r.unitPricePence;
  if (each === undefined || each === null || String(each).trim() === '') return raw;
  const unit = parseMoney(String(each));
  if (unit === null || unit < 0) return { ...r, totalGrossPence: 'invalid' };
  const qty = Math.max(1, Math.floor(Number(r.quantity) || 1));
  return { ...r, totalGrossPence: ((unit * qty) / 100).toFixed(2) };
}
