/**
 * Shared (client + server) definitions for laser-engraved fairway mats (e.g. Spurk, engraved on an
 * xTool F2): where the engraving goes, the stored spec, and default prices.
 */
import type { PrintFontKey } from './ball-print';

export type MatPositionKey = 'lip' | 'underside';

export const MAT_POSITIONS: { key: MatPositionKey; label: string; hint: string }[] = [
  { key: 'lip', label: 'Front lip', hint: 'On the black lip at the end of the mat, visible from the top' },
  { key: 'underside', label: 'Underside', hint: 'On the base, under the mat' },
];

/** The laser engraves the logo's shape, so logos need a transparent background. */
export const MAT_LOGO_TYPES = ['image/png', 'image/webp'];
export const MAT_LOGO_HELP = 'Please use a PNG (or WebP) with a transparent background — the laser engraves the shape of the logo, so a white or coloured background would be engraved as a solid block.';

/** Whether a PNG/WebP file can be see-through (has an alpha channel or a transparent colour). */
export function hasTransparency(buf: Uint8Array, mime: string): boolean {
  const ascii = (o: number, n: number) => String.fromCharCode(...buf.subarray(o, o + n));
  if (mime === 'image/png') {
    if (buf.length < 33 || ascii(12, 4) !== 'IHDR') return false;
    const colourType = buf[25];
    if (colourType === 4 || colourType === 6) return true;
    // Palette/greyscale/RGB with a transparent colour: a tRNS chunk before the image data.
    let o = 8;
    while (o + 8 <= buf.length) {
      const len = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
      const type = ascii(o + 4, 4);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      o += 12 + len;
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (buf.length < 21 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return false;
    const chunk = ascii(12, 4);
    if (chunk === 'VP8L') return true; // lossless WebP: alpha is common; the browser check catches solid ones
    if (chunk === 'VP8X') return (buf[20] & 0x10) !== 0;
    return false;
  }
  return false;
}

export const matPositionOf = (key: string) => MAT_POSITIONS.find((p) => p.key === key);

export type MatPile = 'short' | 'long';
export type MatOption = { key: MatPile; name: string; pricePence: number };

/**
 * Mats you sell, each priced with the engraving included; the carry case deal (mat + case + engraving,
 * 0 = not offered); engraving-only prices per position for a customer's own mat; a setup fee per job.
 */
export type MatPrices = { mats: MatOption[]; caseDealPence: number; positions: Record<MatPositionKey, number>; setupFeePence: number };

export const DEFAULT_MAT_PRICES: MatPrices = {
  mats: [
    { key: 'short', name: 'Spurk Fairway Mat — Short Pile', pricePence: 0 },
    { key: 'long', name: 'Spurk Fairway Mat — Long Pile', pricePence: 0 },
  ],
  caseDealPence: 0,
  positions: { lip: 1000, underside: 800 },
  setupFeePence: 0,
};

/** "Engraving only": the customer brings their own mat. */
export const OWN_MAT = 'own';

export function matPrices(saved: Partial<MatPrices> | null | undefined): MatPrices {
  const mats = DEFAULT_MAT_PRICES.mats.map((d) => ({ ...d, ...(saved?.mats?.find((m) => m.key === d.key) ?? {}) }));
  return {
    mats,
    caseDealPence: saved?.caseDealPence ?? DEFAULT_MAT_PRICES.caseDealPence,
    positions: { ...DEFAULT_MAT_PRICES.positions, ...(saved?.positions ?? {}) },
    setupFeePence: saved?.setupFeePence ?? DEFAULT_MAT_PRICES.setupFeePence,
  };
}

export type MatArtwork =
  | { type: 'text'; lines: string[]; font: PrintFontKey }
  | { type: 'logo'; logo: number; filename: string; mimeType: string; storageKey: string };

/** One engraving: where, what, how big (fraction of the available width), and its price each. */
export type MatEngraving = { position: MatPositionKey; artwork: MatArtwork; scale: number; pricePence: number };

export type MatSpec = {
  kind: 'cos-mat-engraving';
  version: 1;
  mat: { name: string; pricePence: number; pile: MatPile | null; carryCase?: boolean };
  quantity: number;
  engravings: MatEngraving[];
  setupFeePence: number;
  proofKey: string;
  notes: string;
  totalPence: number;
  submittedOnline?: boolean;
};

export function asMatSpec(json: unknown): MatSpec | null {
  const s = json as MatSpec | null;
  return s && typeof s === 'object' && s.kind === 'cos-mat-engraving' && typeof s.proofKey === 'string' ? s : null;
}
