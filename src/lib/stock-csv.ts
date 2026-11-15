import { parseCsv } from './csv';
import { parseMoneyToPence } from './format';

/**
 * Reads stock files:
 *  - Shopify product export  → the catalogue (cost, price, brand, type for every variant)
 *  - Shopify inventory export → quantities per variant (old layout: a column per location; new
 *    layout: a row per location with "On hand"/"Available")
 *  - any other stock list with SKU + quantity (+ cost/price/brand/category if it has them)
 */

export type CatalogueRow = { key: string; sku: string; title: string; variant: string; brand: string; category: string; costPence: number | null; pricePence: number | null };
export type QuantityRow = { key: string; sku: string; title: string; variant: string; quantity: number; brand?: string; category?: string; costPence?: number | null; pricePence?: number | null };
export type StockFile = { kind: 'catalogue'; rows: CatalogueRow[] } | { kind: 'quantities'; rows: QuantityRow[]; locations: string[] };

export class StockCsvError extends Error {}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const idx = (headers: string[], ...names: string[]) => {
  const n = headers.map(norm);
  for (const name of names) {
    const i = n.indexOf(norm(name));
    if (i >= 0) return i;
  }
  return -1;
};

const ACRONYMS = new Set(['PING', 'BOSS', 'PXG', 'OGIO', 'HUGO', 'ECCO', 'UA', 'G/FORE', 'BB&F']);
const BRAND_FIX: Record<string, string> = {
  taylormade: 'TaylorMade', footjoy: 'FootJoy', travismathew: 'TravisMathew', powakaddy: 'PowaKaddy', superstroke: 'SuperStroke', 'us kids': 'US Kids Golf',
  'lyle & scott': 'Lyle & Scott', 'under armour': 'Under Armour', 'golf pride': 'Golf Pride', 'scotty cameron': 'Scotty Cameron', 'shot scope': 'Shot Scope',
};
/** "NIKE" → "Nike", "TAYLORMADE" → "TaylorMade", "PING" stays "PING". */
export function cleanBrand(v: string) {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const fixed = BRAND_FIX[s.toLowerCase()];
  if (fixed) return fixed;
  if (ACRONYMS.has(s.toUpperCase())) return s.toUpperCase();
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s)) return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s;
}

const CATEGORY_GUESS: [RegExp, string][] = [
  [/\bputter/i, 'Putters'], [/\bdriver\b/i, 'Drivers'], [/fairway wood|\bwood\b|\b[357]w\b/i, 'Fairway woods'], [/hybrid|rescue/i, 'Hybrids'],
  [/\birons?\b|iron set/i, 'Irons'], [/wedge/i, 'Wedges'], [/\bballs?\b|pro v1|chrome soft|tour b/i, 'Golf balls'],
  [/shoe|spikeless|spiked/i, 'Shoes'], [/glove/i, 'Gloves'], [/waterproof|rain jacket|rain trouser/i, 'Waterproofs'],
  [/polo|shirt|jumper|sweater|hoodie|jacket|gilet|vest|mid ?layer|trouser|pant|short|skort|base ?layer|top\b|quarter zip|1\/4 zip/i, 'Clothing'],
  [/\bcap\b|hat|visor|beanie|headwear/i, 'Headwear'], [/stand bag|cart bag|tour bag|staff bag|travel|\bbag\b/i, 'Bags'],
  [/trolley|caddy|push cart/i, 'Trolleys'], [/gps|rangefinder|watch|launch monitor|speaker/i, 'Technology'],
  [/grip/i, 'Grips'], [/shaft/i, 'Shafts'], [/umbrella|towel|tee|marker|headcover|accessor|divot/i, 'Accessories'],
];
const TYPE_FIX: [RegExp, string][] = [
  [/^putters?$/i, 'Putters'], [/^drivers?$/i, 'Drivers'], [/fairway/i, 'Fairway woods'], [/hybrid/i, 'Hybrids'], [/^irons?( sets?)?$/i, 'Irons'],
  [/wedge/i, 'Wedges'], [/ball/i, 'Golf balls'], [/shoe|footwear/i, 'Shoes'], [/glove/i, 'Gloves'], [/waterproof/i, 'Waterproofs'],
  [/polo|shirt|jumper|knit|hood|jacket|gilet|mid ?layer|trouser|pant|short|skirt|skort|apparel|clothing|base ?layer|outerwear|top/i, 'Clothing'],
  [/cap|hat|visor|beanie|headwear/i, 'Headwear'], [/bag/i, 'Bags'], [/trolley|cart/i, 'Trolleys'], [/gps|rangefinder|tech|electronic|watch/i, 'Technology'],
  [/grip/i, 'Grips'], [/shaft/i, 'Shafts'], [/accessor|umbrella|towel|tee|headcover/i, 'Accessories'],
];
/**
 * A tidy category from the product type, then the Shopify category path, then the product's name.
 * Types that are really brand names ("Nike", "Hugo Boss") or placeholders ("Uncategorized") are skipped.
 */
export function categoryFor(type: string, shopifyCategory: string, title: string, brand = '') {
  const fix = (v: string) => TYPE_FIX.find(([re]) => re.test(v))?.[1];
  const t = type.trim();
  const useless = !t || /^(uncategori[sz]ed|other|misc|default|products?|golf|n\/?a)$/i.test(t) || (brand && t.toLowerCase().includes(brand.toLowerCase().split(' ')[0])) || /^(nike|under armour|hugo boss|boss|footjoy|adidas|puma|callaway|taylormade|titleist|ping|glenmuir|lyle & scott)$/i.test(t);
  if (!useless && fix(t)) return fix(t)!;
  const leaf = shopifyCategory.split('>').pop()?.trim() ?? '';
  const fromName = guessCategory(title);
  if (/club/i.test(t) || /club/i.test(leaf)) return fromName !== 'Other' ? fromName : 'Clubs';
  if (leaf && fix(leaf)) return fix(leaf)!;
  if (fromName !== 'Other') return fromName;
  return useless ? 'Other' : t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
export const guessCategory = (title: string) => CATEGORY_GUESS.find(([re]) => re.test(title))?.[1] ?? 'Other';

export const keyFor = (handle: string, opts: string[]) =>
  [handle, ...opts.map((o) => (o.toLowerCase() === 'default title' ? '' : o))].map((s) => s.trim().toLowerCase()).join('|').replace(/\|+$/, '');
export const variantName = (opts: string[]) => opts.filter((o) => o && o.toLowerCase() !== 'default title').join(' / ');
const pence = (v: string | undefined) => {
  const s = (v ?? '').trim().replace(/[£,]/g, '');
  if (!s) return null;
  const p = parseMoneyToPence(s);
  return p === null ? null : p;
};
const int = (v: string | undefined) => {
  const s = (v ?? '').trim();
  if (!/^-?\d+(\.0+)?$/.test(s)) return null;
  return Math.round(Number(s));
};

const STANDARD = new Set(
  ['handle', 'title', 'option1name', 'option1value', 'option2name', 'option2value', 'option3name', 'option3value', 'sku', 'hscode', 'coo', 'location', 'binname',
    'incomingnoteditable', 'unavailablenoteditable', 'committednoteditable', 'availablenoteditable', 'onhandcurrent', 'onhandnew', 'variantsku'].map(norm),
);

export function parseStockCsv(text: string): StockFile {
  const table = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  if (table.length < 2) throw new StockCsvError('That file is empty.');
  const h = table[0];
  const rows = table.slice(1);
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const iHandle = idx(h, 'Handle');
  const iO = [idx(h, 'Option1 Value'), idx(h, 'Option2 Value'), idx(h, 'Option3 Value')];
  const iSku = idx(h, 'Variant SKU', 'SKU', 'Product code', 'Item code', 'Barcode');

  // 1. Shopify product export: the catalogue.
  const iCost = idx(h, 'Cost per item', 'Cost', 'Cost price', 'Unit cost');
  const iVendor = idx(h, 'Vendor', 'Brand', 'Manufacturer', 'Supplier');
  const iQty = idx(h, 'On hand (current)', 'On hand', 'Available (not editable)', 'Available', 'Quantity', 'Qty', 'Stock', 'In stock', 'Stock level', 'Variant Inventory Qty');
  if (iHandle >= 0 && iCost >= 0 && iVendor >= 0 && iQty < 0) {
    const iTitle = idx(h, 'Title');
    const iType = idx(h, 'Type');
    const iCat = idx(h, 'Product Category');
    const iPrice = idx(h, 'Variant Price', 'Price / United Kingdom', 'Price');
    const iStatus = idx(h, 'Status');
    const parent = new Map<string, { title: string; brand: string; type: string; cat: string; status: string }>();
    const out: CatalogueRow[] = [];
    for (const r of rows) {
      const handle = get(r, iHandle);
      if (!handle) continue;
      if (get(r, iTitle)) parent.set(handle, { title: get(r, iTitle), brand: get(r, iVendor), type: get(r, iType), cat: get(r, iCat), status: get(r, iStatus) });
      const p = parent.get(handle);
      const opts = iO.map((i) => get(r, i));
      // Image-only rows have no option values and no price: skip them.
      if (!opts[0] && !get(r, iPrice) && !get(r, iSku)) continue;
      if (!p) continue;
      out.push({
        key: keyFor(handle, opts), sku: get(r, iSku), title: p.title, variant: variantName(opts), brand: cleanBrand(p.brand),
        category: categoryFor(p.type, p.cat, p.title, p.brand), costPence: pence(get(r, iCost)), pricePence: pence(get(r, iPrice)),
      });
    }
    if (!out.length) throw new StockCsvError('No products found in that export.');
    return { kind: 'catalogue', rows: out };
  }

  // 2. Shopify inventory export (or any stock list with quantities).
  const iTitle = idx(h, 'Title', 'Product', 'Description', 'Name', 'Item');
  const iLocation = idx(h, 'Location');
  let locations: string[] = [];
  let qtyCols: number[] = [];
  if (iQty >= 0) qtyCols = [iQty];
  else if (iHandle >= 0) {
    // Old Shopify layout: one column per location, after the standard ones.
    qtyCols = h.map((x, i) => (STANDARD.has(norm(x)) ? -1 : i)).filter((i) => i >= 0);
    locations = qtyCols.map((i) => h[i]);
  }
  if (!qtyCols.length) throw new StockCsvError('Couldn’t find a quantity column. Use Shopify’s inventory export (Products → Inventory → Export), or a list with SKU and Quantity columns.');
  const iBrand = iVendor;
  const iCategory = idx(h, 'Category', 'Type', 'Department', 'Product type');
  const iPrice = idx(h, 'Price', 'Retail price', 'RRP', 'Selling price', 'Variant Price');
  const merged = new Map<string, QuantityRow>();
  for (const r of rows) {
    const qty = qtyCols.reduce((n, i) => n + (int(get(r, i)) ?? 0), 0);
    if (!qty) continue;
    if (iLocation >= 0 && get(r, iLocation) && !locations.includes(get(r, iLocation))) locations.push(get(r, iLocation));
    const opts = iO.map((i) => get(r, i));
    const sku = get(r, iSku);
    const handle = get(r, iHandle);
    const key = handle ? keyFor(handle, opts) : `sku:${sku.toLowerCase()}`;
    if (!handle && !sku) continue;
    const prev = merged.get(key);
    if (prev) {
      prev.quantity += qty; // the same variant at several locations
      continue;
    }
    merged.set(key, {
      key, sku, title: get(r, iTitle) || handle || sku, variant: variantName(opts), quantity: qty,
      ...(iCost >= 0 ? { costPence: pence(get(r, iCost)) } : {}),
      ...(iPrice >= 0 ? { pricePence: pence(get(r, iPrice)) } : {}),
      ...(iBrand >= 0 ? { brand: cleanBrand(get(r, iBrand)) } : {}),
      ...(iCategory >= 0 ? { category: categoryFor(get(r, iCategory), '', get(r, iTitle)) } : {}),
    });
  }
  if (!merged.size) throw new StockCsvError('No stock found in that file (every quantity was zero or blank).');
  return { kind: 'quantities', rows: [...merged.values()], locations };
}
