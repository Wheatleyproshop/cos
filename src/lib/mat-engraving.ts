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

export const matPositionOf = (key: string) => MAT_POSITIONS.find((p) => p.key === key);

/** Mat price (each), engraving price per position (each), and a one-off setup fee per job. */
export type MatPrices = { matName: string; matPricePence: number; positions: Record<MatPositionKey, number>; setupFeePence: number };

export const DEFAULT_MAT_PRICES: MatPrices = {
  matName: 'Spurk Fairway Mat',
  matPricePence: 0,
  positions: { lip: 1000, underside: 800 },
  setupFeePence: 0,
};

export function matPrices(saved: Partial<MatPrices> | null | undefined): MatPrices {
  return {
    matName: saved?.matName || DEFAULT_MAT_PRICES.matName,
    matPricePence: saved?.matPricePence ?? DEFAULT_MAT_PRICES.matPricePence,
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
  mat: { name: string; pricePence: number };
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
