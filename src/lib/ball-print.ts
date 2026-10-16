/**
 * Shared (client + server) definitions for golf ball printing: the text styles
 * and ink colours staff can choose, and the structured spec stored on the quote.
 */

export const PRINT_FONTS = [
  { key: 'classic', label: 'Classic serif', css: '600 {size}px Georgia, "Times New Roman", serif' },
  { key: 'modern', label: 'Modern sans', css: '700 {size}px "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { key: 'bold', label: 'Bold block', css: '900 {size}px "Arial Black", "Helvetica Neue", Arial, sans-serif' },
  { key: 'script', label: 'Script', css: 'italic 600 {size}px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive' },
  { key: 'mono', label: 'Typewriter', css: '700 {size}px "Courier New", Courier, monospace' },
] as const;

export const INK_COLOURS = [
  { key: 'black', label: 'Black', hex: '#111111' },
  { key: 'navy', label: 'Navy', hex: '#16233a' },
  { key: 'royal', label: 'Royal blue', hex: '#1f4fbf' },
  { key: 'red', label: 'Red', hex: '#c8102e' },
  { key: 'green', label: 'Green', hex: '#0d6b3a' },
  { key: 'gold', label: 'Gold', hex: '#b08a2e' },
  { key: 'pink', label: 'Pink', hex: '#d63f8c' },
] as const;

export type PrintFontKey = (typeof PRINT_FONTS)[number]['key'];
export type InkKey = (typeof INK_COLOURS)[number]['key'];

/** A sensible starting range a shop can add in one click, then edit or retire. Prices are typical UK RRPs incl. printing. */
export const STARTER_BALLS = [
  { brand: 'Titleist', name: 'Pro V1', colour: '#ffffff', price: 6499 },
  { brand: 'Titleist', name: 'Pro V1x', colour: '#ffffff', price: 6499 },
  { brand: 'Titleist', name: 'Pro V1 Yellow', colour: '#f2e33a', price: 6499 },
  { brand: 'Titleist', name: 'AVX', colour: '#ffffff', price: 5999 },
  { brand: 'Titleist', name: 'Tour Soft', colour: '#ffffff', price: 4499 },
  { brand: 'Titleist', name: 'Velocity', colour: '#ffffff', price: 3499 },
  { brand: 'TaylorMade', name: 'TP5', colour: '#ffffff', price: 5999 },
  { brand: 'TaylorMade', name: 'Tour Response', colour: '#ffffff', price: 4499 },
  { brand: 'Callaway', name: 'Chrome Tour', colour: '#ffffff', price: 5999 },
  { brand: 'Callaway', name: 'Supersoft', colour: '#ffffff', price: 3299 },
  { brand: 'Srixon', name: 'Z-Star', colour: '#ffffff', price: 5499 },
  { brand: 'Srixon', name: 'Q-Star Tour', colour: '#ffffff', price: 4299 },
  { brand: 'Bridgestone', name: 'Tour B X', colour: '#ffffff', price: 5999 },
] as const;

export const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MAX_LOGO_BYTES = 3 * 1024 * 1024; // logo + proof must stay under Vercel's 4.5 MB request limit
export const MAX_PROOF_BYTES = 1024 * 1024;

export type BallPrintSpec = {
  kind: 'cos-ball-print';
  version: 1;
  ball: { id: string; brand: string; name: string; colour: string };
  artwork:
    | { type: 'logo'; filename: string; mimeType: string; storageKey: string; scale: number }
    | { type: 'text'; lines: string[]; font: PrintFontKey; ink: InkKey; scale: number };
  proofKey: string;
  dozens: number;
  pricePerDozenPence: number;
  setupFeePence: number;
  notes: string;
  totalPence: number;
};

export function asBallPrintSpec(json: unknown): BallPrintSpec | null {
  const s = json as BallPrintSpec | null;
  return s && typeof s === 'object' && s.kind === 'cos-ball-print' && typeof s.proofKey === 'string' ? s : null;
}

/** Checks the file really is the image type it claims (never trust the browser-supplied MIME type). */
export function sniffImage(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && String.fromCharCode(...buf.slice(0, 4)) === 'RIFF' && String.fromCharCode(...buf.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
