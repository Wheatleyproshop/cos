import { money } from './format';

/**
 * The structured specification of a Custom Fitting quote/order: one or more club builds,
 * each a list of labelled lines (Head, Loft, Shaft, Flex, Grip…) with their prices.
 * Stored in `specification_json`; shared by staff pages, customer pages and emails.
 */
export type SpecLine = { label: string; value: string; pricePence: number; detail?: string };
export type SpecBuild = { title: string; category?: string; lines: SpecLine[]; notes?: string; totalPence: number };
export type FitSpec = { kind: 'cos-configure'; version: 2; builds: SpecBuild[]; notes?: string; totalPence: number };

type V1 = {
  kind: 'cos-configure'; version: 1;
  model: { name: string; brand: string; category?: string; basePricePence: number };
  items: { category: string; name: string; upchargePence: number }[];
  notes?: string; totalPence: number;
};

/** Reads a fitting spec (including quotes saved before multi-club fitting). Null for anything else. */
export function fitSpec(json: unknown): FitSpec | null {
  const s = json as Partial<FitSpec> & Partial<V1> & { kind?: string; version?: number };
  if (!s || typeof s !== 'object' || s.kind !== 'cos-configure') return null;
  if (s.version === 2 && Array.isArray(s.builds)) return s as FitSpec;
  if (s.version === 1 && s.model) {
    const v1 = s as V1;
    const lines: SpecLine[] = [
      { label: 'Head', value: `${v1.model.brand} ${v1.model.name}`.trim(), pricePence: v1.model.basePricePence },
      ...v1.items.map((i) => ({ label: i.category, value: i.name, pricePence: i.upchargePence })),
    ];
    return {
      kind: 'cos-configure', version: 2, totalPence: v1.totalPence,
      builds: [{ title: `${v1.model.brand} ${v1.model.name}`.trim(), category: v1.model.category, lines, notes: v1.notes, totalPence: v1.totalPence }],
    };
  }
  return null;
}

export function priceText(pence: number) {
  return pence > 0 ? money(pence) : pence < 0 ? `−${money(-pence)}` : 'Included';
}

/** Plain-text version, one detail per line, for the text email and the quote's specification field. */
export function fitSpecText(spec: FitSpec): string {
  const blocks = spec.builds.map((b, i) => {
    const head = spec.builds.length > 1 ? `${i + 1}. ${b.title} — ${money(b.totalPence)}` : `${b.title} — ${money(b.totalPence)}`;
    const rows = b.lines.map((l) => `   ${l.label}: ${l.value}${l.pricePence ? ` — ${priceText(l.pricePence)}` : ''}${l.detail ? ` (${l.detail})` : ''}`);
    return [head, ...rows, ...(b.notes ? [`   Notes: ${b.notes}`] : [])].join('\n');
  });
  return [...blocks, ...(spec.notes ? ['', spec.notes] : [])].join('\n\n');
}
