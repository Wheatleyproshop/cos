/**
 * Canvas drawing for laser-engraved fairway mats. The mat is drawn (not photographed): seen from above
 * with the black lip at the front, or from underneath. Laser engraving on black plastic shows as a
 * light, frosted mark, so text and logos are drawn as a single engraved tone.
 */
import { PRINT_FONTS, type PrintFontKey } from '@/lib/ball-print';
import type { MatPositionKey } from '@/lib/mat-engraving';

export type MatDrawArt =
  | { type: 'text'; lines: string[]; font: PrintFontKey }
  | { type: 'logo'; image: CanvasImageSource & { width: number; height: number } };

export type MatDrawEngraving = { position: MatPositionKey; art: MatDrawArt | null; scale: number };
export type MatView = 'top' | 'underside';

const ENGRAVE = '#d7dbd3';

/** Same "random" turf every time, so previews and proofs match. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function geometry(size: number) {
  const w = size * 0.4;
  const h = size * 0.86;
  const x = (size - w) / 2;
  const y = size * 0.07;
  const lipH = h * 0.15;
  return { w, h, x, y, lipH, r: size * 0.018 };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The artwork as a single-tone engraving, sized to fit (maxW × maxH). */
function engravingCanvas(art: MatDrawArt, maxW: number, maxH: number): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  if (art.type === 'text') {
    const lines = art.lines.map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const font = PRINT_FONTS.find((f) => f.key === art.font) ?? PRINT_FONTS[1];
    const m = document.createElement('canvas').getContext('2d')!;
    m.font = font.css.replace('{size}', '100');
    const widest = Math.max(...lines.map((l) => m.measureText(l).width), 1);
    const px = Math.max(5, Math.min((100 * maxW) / widest, maxH / (lines.length * 1.18)));
    const lineH = px * 1.18;
    c.width = Math.ceil(maxW);
    c.height = Math.ceil(lineH * lines.length);
    const g = c.getContext('2d')!;
    g.font = font.css.replace('{size}', String(px));
    g.fillStyle = ENGRAVE;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, c.width / 2, lineH * (i + 0.5)));
  } else {
    const { image } = art;
    const s = Math.min(maxW / image.width, maxH / image.height);
    c.width = Math.max(1, Math.round(image.width * s));
    c.height = Math.max(1, Math.round(image.height * s));
    const g = c.getContext('2d')!;
    g.drawImage(image, 0, 0, c.width, c.height);
    // One tone: on a solid background the dark parts are engraved; on a transparent PNG the shape is.
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    let alphaSum = 0;
    for (let i = 3; i < px.length; i += 4) alphaSum += px[i];
    const opaque = alphaSum / (px.length / 4) > 245;
    const [er, eg, eb] = [0xd7, 0xdb, 0xd3];
    for (let i = 0; i < px.length; i += 4) {
      const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
      const a = px[i + 3] / 255;
      const mask = opaque ? Math.max(0, Math.min(1, (0.85 - lum) / 0.6)) : a * (lum > 0.92 ? 0.15 : 1);
      px[i] = er;
      px[i + 1] = eg;
      px[i + 2] = eb;
      px[i + 3] = Math.round(mask * 255);
    }
    g.putImageData(d, 0, 0);
  }
  // A laser mark is slightly frosted, not flat paint.
  const g = c.getContext('2d')!;
  const rand = rng(7);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < (c.width * c.height) / 18; i++) {
    g.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(80,85,80,0.18)';
    g.fillRect(rand() * c.width, rand() * c.height, 1, 1);
  }
  g.restore();
  return c;
}

function drawTurf(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, '#3f9a33');
  grad.addColorStop(1, '#2a7a24');
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  const rand = rng(42);
  const blades = Math.round((w * h) / 9);
  const greens = ['#5fbf45', '#2f8a2a', '#76cf52', '#22691d', '#4aa83a', '#9be06b'];
  g.lineCap = 'round';
  for (let i = 0; i < blades; i++) {
    const bx = x + rand() * w;
    const by = y + rand() * h;
    const len = 1.5 + rand() * 3.5;
    const a = rand() * Math.PI * 2;
    g.strokeStyle = greens[Math.floor(rand() * greens.length)];
    g.globalAlpha = 0.55 + rand() * 0.45;
    g.lineWidth = 0.8 + rand() * 0.9;
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx + Math.cos(a) * len, by + Math.sin(a) * len);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** Where engravings sit on each view: the lip strip from above, or a panel on the base. */
function engravingArea(view: MatView, size: number) {
  const { w, h, x, y, lipH } = geometry(size);
  return view === 'top'
    ? { x: x + w * 0.06, y: y + h - lipH + lipH * 0.16, w: w * 0.88, h: lipH * 0.68 }
    : { x: x + w * 0.1, y: y + h * 0.3, w: w * 0.8, h: h * 0.4 };
}

export function drawMat(g: CanvasRenderingContext2D, size: number, view: MatView, engravings: MatDrawEngraving[], opts: { guide?: boolean; label?: string } = {}) {
  const { w, h, x, y, lipH, r } = geometry(size);
  g.clearRect(0, 0, size, size);
  const bg = g.createRadialGradient(size / 2, size * 0.35, size * 0.1, size / 2, size / 2, size * 0.75);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(1, '#e4e7ec');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  // Shadow + base plate.
  g.save();
  g.shadowColor = 'rgba(14,21,34,0.35)';
  g.shadowBlur = size * 0.04;
  g.shadowOffsetY = size * 0.015;
  roundRect(g, x, y, w, h, r);
  g.fillStyle = '#141516';
  g.fill();
  g.restore();

  if (view === 'top') {
    // Turf covers the mat except the lip at the front.
    g.save();
    roundRect(g, x + size * 0.006, y + size * 0.006, w - size * 0.012, h - lipH - size * 0.006, r * 0.7);
    g.clip();
    drawTurf(g, x, y, w, h - lipH);
    g.restore();
    // Lip: a faint highlight where the plate catches the light.
    const lip = g.createLinearGradient(0, y + h - lipH, 0, y + h);
    lip.addColorStop(0, '#2a2c2e');
    lip.addColorStop(0.25, '#18191a');
    lip.addColorStop(1, '#0f1011');
    g.fillStyle = lip;
    g.fillRect(x + r * 0.3, y + h - lipH, w - r * 0.6, lipH - r * 0.6);
  } else {
    // Underside: moulded plate with a raised rim and four feet.
    g.strokeStyle = '#2b2d30';
    g.lineWidth = size * 0.006;
    roundRect(g, x + size * 0.02, y + size * 0.02, w - size * 0.04, h - size * 0.04, r * 0.6);
    g.stroke();
    g.fillStyle = '#0b0c0d';
    for (const [fx, fy] of [[0.18, 0.16], [0.82, 0.16], [0.18, 0.84], [0.82, 0.84]]) {
      g.beginPath();
      g.ellipse(x + w * fx, y + h * fy, w * 0.07, w * 0.05, 0, 0, Math.PI * 2);
      g.fill();
    }
  }

  const area = engravingArea(view, size);
  if (opts.guide) {
    g.save();
    g.setLineDash([5, 4]);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.strokeRect(area.x, area.y, area.w, area.h);
    g.restore();
  }
  for (const e of engravings) {
    const onThisView = (view === 'top' && e.position === 'lip') || (view === 'underside' && e.position === 'underside');
    if (!onThisView || !e.art) continue;
    const art = engravingCanvas(e.art, area.w * Math.max(0.2, Math.min(1, e.scale)), area.h);
    if (!art) continue;
    g.drawImage(art, area.x + (area.w - art.width) / 2, area.y + (area.h - art.height) / 2);
  }

  if (opts.label) {
    const fs = Math.round(size / 34);
    g.font = `700 ${fs}px system-ui, sans-serif`;
    const tw = g.measureText(opts.label).width;
    g.fillStyle = 'rgba(14,21,34,0.75)';
    g.fillRect(size * 0.03, size * 0.03, tw + fs * 1.2, fs * 1.8);
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(opts.label, size * 0.03 + fs * 0.6, size * 0.03 + fs * 0.9);
  }
}

/** The proof: the top (and the underside if it's engraved) side by side, as a JPEG. */
export async function renderMatProof(engravings: MatDrawEngraving[]): Promise<File> {
  const size = 900;
  const views: MatView[] = engravings.some((e) => e.position === 'underside' && e.art) ? ['top', 'underside'] : ['top'];
  const c = document.createElement('canvas');
  c.width = size * views.length + (views.length - 1) * 20;
  c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  views.forEach((v, i) => {
    const p = document.createElement('canvas');
    p.width = p.height = size;
    drawMat(p.getContext('2d')!, size, v, engravings, { label: views.length > 1 ? (v === 'top' ? 'Top' : 'Underside') : undefined });
    g.drawImage(p, i * (size + 20), 0);
  });
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Could not create the preview image');
  return new File([blob], 'proof.jpg', { type: 'image/jpeg' });
}
