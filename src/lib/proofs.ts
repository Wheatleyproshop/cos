import { asBallPrintSpec } from './ball-print';
import { asCrestSpec } from './cresting';

/** The rendered proof image behind a ball-printing or cresting quote/order, if it has one. */
export function proofOf(json: unknown): { proofKey: string; mime: string; kind: 'ball' | 'cresting' } | null {
  const key = asBallPrintSpec(json)?.proofKey ?? asCrestSpec(json)?.proofKey;
  if (!key) return null;
  const mime = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { proofKey: key, mime, kind: asCrestSpec(json) ? 'cresting' : 'ball' };
}
