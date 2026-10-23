/**
 * Shared (client + server) definitions for clothing cresting: where a logo or text can go,
 * embroidery vs print, thread/ink colours, sizes, default prices and the spec stored on the quote.
 */
import type { PrintFontKey } from './ball-print';

export type GarmentType = 'apparel' | 'cap';
export type CrestView = 'front' | 'back';
export type CrestMethod = 'embroidery' | 'print';

export const CREST_METHODS: { key: CrestMethod; label: string }[] = [
  { key: 'embroidery', label: 'Embroidery' },
  { key: 'print', label: 'Print' },
];

/** Default spot on the garment photo: x/y are the artwork centre, w its width, all as fractions of the photo. */
export const CREST_POSITIONS = [
  { key: 'left_chest', label: 'Left chest', garment: 'apparel', view: 'front', x: 0.64, y: 0.33, w: 0.15 },
  { key: 'right_chest', label: 'Right chest', garment: 'apparel', view: 'front', x: 0.36, y: 0.33, w: 0.15 },
  { key: 'left_sleeve', label: 'Left sleeve', garment: 'apparel', view: 'front', x: 0.86, y: 0.3, w: 0.08 },
  { key: 'right_sleeve', label: 'Right sleeve', garment: 'apparel', view: 'front', x: 0.14, y: 0.3, w: 0.08 },
  { key: 'back', label: 'Back', garment: 'apparel', view: 'back', x: 0.5, y: 0.3, w: 0.38 },
  { key: 'cap_front', label: 'Cap front', garment: 'cap', view: 'front', x: 0.5, y: 0.42, w: 0.3 },
  { key: 'cap_side', label: 'Cap side', garment: 'cap', view: 'back', x: 0.5, y: 0.5, w: 0.2 },
] as const satisfies readonly { key: string; label: string; garment: GarmentType; view: CrestView; x: number; y: number; w: number }[];

export type CrestPositionKey = (typeof CREST_POSITIONS)[number]['key'];

export const positionOf = (key: string) => CREST_POSITIONS.find((p) => p.key === key);

/** Thread / ink colours. White first: the usual choice on dark garments. */
export const THREAD_COLOURS = [
  { key: 'white', label: 'White', hex: '#ffffff' },
  { key: 'black', label: 'Black', hex: '#111111' },
  { key: 'navy', label: 'Navy', hex: '#16233a' },
  { key: 'royal', label: 'Royal blue', hex: '#1f4fbf' },
  { key: 'red', label: 'Red', hex: '#c8102e' },
  { key: 'green', label: 'Green', hex: '#0d6b3a' },
  { key: 'gold', label: 'Gold', hex: '#b08a2e' },
  { key: 'silver', label: 'Silver grey', hex: '#a7adb5' },
  { key: 'pink', label: 'Pink', hex: '#d63f8c' },
] as const;
export type ThreadKey = (typeof THREAD_COLOURS)[number]['key'];

export const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] as const;
export const CAP_SIZES = ['One size'] as const;

/** Per position, per method, per item; plus a one-off setup / digitising fee per job. */
export type CrestPrices = { positions: Record<string, Record<CrestMethod, number>>; setupFeePence: number };

export const DEFAULT_CREST_PRICES: CrestPrices = {
  positions: {
    left_chest: { embroidery: 600, print: 500 },
    right_chest: { embroidery: 600, print: 500 },
    left_sleeve: { embroidery: 500, print: 400 },
    right_sleeve: { embroidery: 500, print: 400 },
    back: { embroidery: 1200, print: 900 },
    cap_front: { embroidery: 600, print: 500 },
    cap_side: { embroidery: 400, print: 350 },
  },
  setupFeePence: 2500,
};

/** The shop's prices with any gaps filled from the defaults. */
export function crestPrices(saved: Partial<CrestPrices> | null | undefined): CrestPrices {
  const positions: CrestPrices['positions'] = {};
  for (const p of CREST_POSITIONS) positions[p.key] = { ...DEFAULT_CREST_PRICES.positions[p.key], ...(saved?.positions?.[p.key] ?? {}) };
  return { positions, setupFeePence: saved?.setupFeePence ?? DEFAULT_CREST_PRICES.setupFeePence };
}

export type CrestArtwork =
  | { type: 'logo'; logo: number; filename: string; mimeType: string; storageKey: string }
  | { type: 'text'; lines: string[]; font: PrintFontKey };

export type CrestPlacement = {
  position: CrestPositionKey;
  method: CrestMethod;
  colour: ThreadKey;
  x: number;
  y: number;
  w: number;
  pricePence: number;
  artwork: CrestArtwork;
};

export type CrestSpec = {
  kind: 'cos-cresting';
  version: 1;
  garment: { type: GarmentType; brand: string; description: string; colour: string; pricePence: number };
  photos: { front: { storageKey: string; mimeType: string }; back?: { storageKey: string; mimeType: string } };
  placements: CrestPlacement[];
  sizes: Record<string, number>;
  quantity: number;
  setupFeePence: number;
  proofKey: string;
  notes: string;
  totalPence: number;
};

export function asCrestSpec(json: unknown): CrestSpec | null {
  const s = json as CrestSpec | null;
  return s && typeof s === 'object' && s.kind === 'cos-cresting' && typeof s.proofKey === 'string' ? s : null;
}

/** Per item: garment + every position. */
export const itemPrice = (garmentPence: number, placements: Pick<CrestPlacement, 'pricePence'>[]) =>
  garmentPence + placements.reduce((t, p) => t + p.pricePence, 0);

export const sizesText = (sizes: Record<string, number>) =>
  Object.entries(sizes)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} × ${n}`)
    .join(', ');
