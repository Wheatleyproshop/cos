/**
 * Canvas drawing for clothing cresting: the garment photo with each logo or text on top.
 * Embroidery gets a raised, stitched look; print sits flat on the fabric.
 * Positions are fractions of the square stage, so they survive any canvas size.
 */
import { PRINT_FONTS, type PrintFontKey } from '@/lib/ball-print';
import { THREAD_COLOURS, type CrestMethod, type ThreadKey } from '@/lib/cresting';

export type DrawPlacement = {
  id: string;
  method: CrestMethod;
  colour: ThreadKey;
  x: number;
  y: number;
  w: number;
  art: { type: 'logo'; image: CanvasImageSource & { width: number; height: number } } | { type: 'text'; lines: string[]; font: PrintFontKey } | null;
};

const hexOf = (k: ThreadKey) => THREAD_COLOURS.find((c) => c.key === k)?.hex ?? '#ffffff';

/** Draws the artwork on its own canvas (so embroidery effects only touch the artwork). Returns null if nothing to draw. */
function artworkCanvas(p: DrawPlacement, size: number): HTMLCanvasElement | null {
  const width = Math.max(8, Math.round(p.w * size));
  if (!p.art) return null;
  const c = document.createElement('canvas');
  if (p.art.type === 'logo') {
    const { image } = p.art;
    const h = Math.max(4, Math.round((width * image.height) / Math.max(1, image.width)));
    c.width = width;
    c.height = h;
    c.getContext('2d')!.drawImage(image, 0, 0, width, h);
    return c;
  }
  const lines = p.art.lines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const font = PRINT_FONTS.find((f) => f.key === (p.art as { font: PrintFontKey }).font) ?? PRINT_FONTS[1];
  const m = document.createElement('canvas').getContext('2d')!;
  // Fit the widest line to the artwork width.
  m.font = font.css.replace('{size}', '100');
  const widest = Math.max(...lines.map((l) => m.measureText(l).width), 1);
  const px = Math.max(6, Math.min(width / 1.2, (100 * width) / widest));
  const lineH = px * 1.15;
  c.width = width;
  c.height = Math.ceil(lineH * lines.length + px * 0.2);
  const g = c.getContext('2d')!;
  g.font = font.css.replace('{size}', String(px));
  g.fillStyle = hexOf(p.colour);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => g.fillText(l, width / 2, lineH * (i + 0.5) + px * 0.1));
  return c;
}

function stitchPattern(g: CanvasRenderingContext2D) {
  const t = document.createElement('canvas');
  t.width = t.height = 6;
  const s = t.getContext('2d')!;
  s.strokeStyle = 'rgba(0,0,0,0.55)';
  s.lineWidth = 1;
  s.beginPath();
  s.moveTo(0, 6);
  s.lineTo(6, 0);
  s.stroke();
  s.strokeStyle = 'rgba(255,255,255,0.7)';
  s.beginPath();
  s.moveTo(0, 3);
  s.lineTo(3, 0);
  s.stroke();
  return g.createPattern(t, 'repeat');
}

/** The artwork with its finish applied: embroidery = thread texture + raised shadow; print = flat. */
function finished(p: DrawPlacement, size: number): HTMLCanvasElement | null {
  const art = artworkCanvas(p, size);
  if (!art || p.method !== 'embroidery') return art;
  const g = art.getContext('2d')!;
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.globalAlpha = 0.22;
  g.fillStyle = stitchPattern(g)!;
  g.fillRect(0, 0, art.width, art.height);
  g.restore();
  return art;
}

/** Bounding box of a placement on the stage, in canvas pixels. */
export function placementBox(p: DrawPlacement, size: number) {
  const art = artworkCanvas(p, size);
  const w = art?.width ?? p.w * size;
  const h = art?.height ?? p.w * size * 0.4;
  return { x: p.x * size - w / 2, y: p.y * size - h / 2, w, h };
}

export function drawStage(
  g: CanvasRenderingContext2D,
  size: number,
  photo: (CanvasImageSource & { width: number; height: number }) | null,
  placements: DrawPlacement[],
  opts: { selected?: string | null; label?: string } = {},
) {
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#f3f4f6';
  g.fillRect(0, 0, size, size);
  if (photo) {
    const s = Math.min(size / photo.width, size / photo.height);
    const w = photo.width * s;
    const h = photo.height * s;
    g.drawImage(photo, (size - w) / 2, (size - h) / 2, w, h);
  } else {
    g.fillStyle = '#9aa1ab';
    g.font = `600 ${Math.round(size / 28)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Upload a photo of the garment', size / 2, size / 2);
  }
  for (const p of placements) {
    const art = finished(p, size);
    if (!art) continue;
    const x = p.x * size - art.width / 2;
    const y = p.y * size - art.height / 2;
    g.save();
    if (p.method === 'embroidery') {
      // Raised thread: a soft shadow below, a faint highlight above.
      g.shadowColor = 'rgba(0,0,0,0.45)';
      g.shadowBlur = size / 400;
      g.shadowOffsetY = size / 700;
    } else {
      g.globalAlpha = 0.96;
    }
    g.drawImage(art, x, y);
    g.restore();
    if (opts.selected === p.id) {
      g.save();
      g.setLineDash([6, 5]);
      g.lineWidth = Math.max(1.5, size / 500);
      g.strokeStyle = '#2f80ff';
      g.strokeRect(x - 6, y - 6, art.width + 12, art.height + 12);
      g.restore();
    }
  }
  if (opts.label) {
    g.fillStyle = 'rgba(14,21,34,0.75)';
    const fs = Math.round(size / 34);
    g.font = `700 ${fs}px system-ui, sans-serif`;
    const tw = g.measureText(opts.label).width;
    g.fillRect(size * 0.03, size * 0.03, tw + fs * 1.2, fs * 1.8);
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(opts.label, size * 0.03 + fs * 0.6, size * 0.03 + fs * 0.9);
  }
}

/** The proof sent to the customer: front (and back/side if used) side by side, as a JPEG. */
export async function renderCrestProof(panels: { label: string; photo: (CanvasImageSource & { width: number; height: number }) | null; placements: DrawPlacement[] }[]): Promise<File> {
  const size = 900;
  const c = document.createElement('canvas');
  c.width = size * panels.length + (panels.length - 1) * 20;
  c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  panels.forEach((p, i) => {
    const panel = document.createElement('canvas');
    panel.width = panel.height = size;
    drawStage(panel.getContext('2d')!, size, p.photo, p.placements, { label: panels.length > 1 ? p.label : undefined });
    g.drawImage(panel, i * (size + 20), 0);
  });
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Could not create the preview image');
  return new File([blob], 'proof.jpg', { type: 'image/jpeg' });
}

/** Shrinks a phone photo before upload (keeps requests well under the 4.5 MB limit). */
export async function shrinkPhoto(file: File, max = 1400): Promise<{ file: File; image: HTMLImageElement }> {
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('That image could not be read.'));
    i.src = url;
  });
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('That image could not be read.');
  const out = new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  const shrunk = new Image();
  shrunk.src = URL.createObjectURL(out);
  await new Promise((r) => (shrunk.onload = r));
  return { file: out, image: shrunk };
}
