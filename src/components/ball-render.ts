import { INK_COLOURS, PRINT_FONTS, type InkKey, type PrintFontKey } from '@/lib/ball-print';

/**
 * A real-time 3D golf ball for the Ball Printing builder and the emailed proof.
 *
 * Every pixel of the ball is ray-cast onto a unit sphere, rotated into ball space, textured
 * with two "decals" (the customer's artwork on the logo side, the brand's sidestamp on the
 * other) and lit with per-pixel dimple normals, so dragging the ball moves print, dimples and
 * highlights together. Decals are orthographic projections of a flat image onto a hemisphere,
 * which is exactly how a straight-on product photo of a ball is formed, so a shop's own photo
 * of e.g. a Pro V1 can be wrapped back onto the ball as its sidestamp.
 */

export type Quat = [number, number, number, number]; // w, x, y, z

export type BallArtwork =
  | { type: 'logo'; image: CanvasImageSource & { width: number; height: number }; scale: number }
  | { type: 'text'; lines: string[]; font: PrintFontKey; ink: InkKey; scale: number }
  | null;

/** A decal covers u, v ∈ [-1, 1] of one hemisphere, as RGBA at DECAL × DECAL. */
export type Decal = { data: Uint8ClampedArray; mode: 'multiply' | 'over' };

export type BallLook = { colour: string; front: Decal | null; back: Decal | null };

const DECAL = 512;
const DIMPLE_ANGLE = 0.094; // radians
const DIMPLE_DEPTH = 0.27;
const PRINT_AREA = 0.6; // half-width of the printable circle, in sphere units

/* ───────────────────────────── Quaternions ───────────────────────────── */

export const IDENTITY: Quat = [1, 0, 0, 0];
/** Brand side: the ball turned half a revolution about its vertical axis. */
export const BRAND_SIDE: Quat = [0, 0, 1, 0];

export function qMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function qAxisAngle(x: number, y: number, z: number, angle: number): Quat {
  const len = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angle / 2) / len;
  return [Math.cos(angle / 2), x * s, y * s, z * s];
}

export function qNormalize(q: Quat): Quat {
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) {
    dot = -dot;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (dot > 0.9995) return qNormalize(a.map((v, i) => v + (bb[i] - v) * t) as Quat);
  const th = Math.acos(dot);
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return a.map((v, i) => v * sa + bb[i] * sb) as Quat;
}

/** Row-major 3×3 rotation (ball space → view space). */
function qMatrix([w, x, y, z]: Quat) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/* ─────────────────────────────── Dimples ─────────────────────────────── */

const DIMPLES = (() => {
  const n = 352; // a typical tour ball has 300–400
  const pts = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    pts[i * 3] = Math.cos(t) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(t) * r;
  }
  return pts;
})();

// Latitude/longitude buckets so each pixel only tests nearby dimples.
const GRID_LAT = 36;
const GRID_LON = 72;
let grid: Int16Array[] | null = null;
function dimpleGrid() {
  if (grid) return grid;
  grid = [];
  const dLat = Math.PI / GRID_LAT / 2;
  for (let a = 0; a < GRID_LAT; a++) {
    const lat = -Math.PI / 2 + ((a + 0.5) / GRID_LAT) * Math.PI;
    // Half the cell diagonal (longitude cells narrow towards the poles), plus the dimple radius.
    const dLon = (Math.PI / GRID_LON) * Math.max(Math.cos(Math.abs(lat) - dLat), 0);
    const reach = Math.cos(Math.min(Math.PI, Math.hypot(dLat, dLon) * 1.15 + DIMPLE_ANGLE));
    for (let b = 0; b < GRID_LON; b++) {
      const lon = -Math.PI + ((b + 0.5) / GRID_LON) * Math.PI * 2;
      const cx = Math.cos(lat) * Math.cos(lon);
      const cy = Math.sin(lat);
      const cz = Math.cos(lat) * Math.sin(lon);
      const list: number[] = [];
      for (let i = 0; i < DIMPLES.length / 3; i++) {
        if (cx * DIMPLES[i * 3] + cy * DIMPLES[i * 3 + 1] + cz * DIMPLES[i * 3 + 2] > reach) list.push(i);
      }
      grid.push(Int16Array.from(list));
    }
  }
  return grid;
}

/* ─────────────────────────────── Decals ─────────────────────────────── */

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function isLightBall(hex: string) {
  const [r, g, b] = hexRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

function decalCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = DECAL;
  return c;
}

/** The customer's logo or text, sized within the print area. White logo backgrounds vanish on light balls, as in pad printing. */
export function artworkDecal(art: BallArtwork, colour: string): Decal | null {
  if (!art) return null;
  const c = decalCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const R = DECAL / 2;
  const maxW = R * PRINT_AREA * 2 * 0.96 * art.scale;
  if (art.type === 'logo') {
    const k = Math.min(maxW / art.image.width, maxW / art.image.height);
    const w = art.image.width * k;
    const h = art.image.height * k;
    ctx.drawImage(art.image, R - w / 2, R - h / 2, w, h);
  } else {
    const lines = art.lines.map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const tpl = PRINT_FONTS.find((f) => f.key === art.font)?.css ?? PRINT_FONTS[0].css;
    let px = R * 0.42 * art.scale * (lines.length === 1 ? 1.15 : lines.length === 2 ? 0.95 : 0.8);
    const fit = () => {
      ctx.font = tpl.replace('{size}', px.toFixed(1));
      return Math.max(...lines.map((l) => ctx.measureText(l).width));
    };
    while (fit() > maxW && px > 4) px *= 0.94;
    ctx.fillStyle = INK_COLOURS.find((x) => x.key === art.ink)?.hex ?? '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lh = px * 1.18;
    lines.forEach((l, i) => ctx.fillText(l, R, R + (i - (lines.length - 1) / 2) * lh));
  }
  const mode = art.type === 'logo' && isLightBall(colour) ? 'multiply' : 'over';
  return { data: ctx.getImageData(0, 0, DECAL, DECAL).data, mode };
}

/** A simple printed sidestamp (brand + model) for balls without a photo. */
export function sidestampDecal(brand: string, model: string, colour: string): Decal {
  const c = decalCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const R = DECAL / 2;
  const light = isLightBall(colour);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = light ? '#14161c' : '#ffffff';
  let px = R * 0.26;
  const setFont = () => (ctx.font = `italic 700 ${px}px Georgia, "Times New Roman", serif`);
  setFont();
  while (ctx.measureText(brand).width > R * 1.15 && px > 6) {
    px *= 0.94;
    setFont();
  }
  ctx.fillText(brand, R, R - R * 0.1);
  ctx.font = `700 ${R * 0.12}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = light ? '#c8102e' : '#ffffff';
  ctx.fillText(model.toUpperCase(), R, R + R * 0.2);
  return { data: ctx.getImageData(0, 0, DECAL, DECAL).data, mode: 'over' };
}

/**
 * Finds the ball in a product photo (on white or transparent backgrounds, ignoring the
 * shadow underneath) and returns its centre and radius in image pixels.
 */
export function findBallCircle(img: CanvasImageSource & { width: number; height: number }) {
  const S = 256;
  const k = S / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const px = (x: number, y: number) => (y * w + x) * 4;
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const bg = [0, 1, 2, 3].map((ch) => corners.reduce((s, i) => s + d[i + ch], 0) / 4);
  const isBall = (i: number) =>
    d[i + 3] > 100 && (bg[3] < 100 || Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30);

  let top = -1;
  let best = 0;
  let bestMid = w / 2;
  for (let y = 0; y < h; y++) {
    let minX = -1;
    let maxX = -1;
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (isBall(px(x, y))) {
        count++;
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    if (count < 3) continue;
    if (top < 0) top = y;
    const width = maxX - minX + 1;
    if (width > best) {
      best = width;
      bestMid = (minX + maxX + 1) / 2;
    }
    // Past the equator: anything wider below is the floor shadow.
    if (y - top > best / 2 + 2) break;
  }
  if (top < 0 || best < S * 0.15) {
    const r = Math.min(img.width, img.height) * 0.45;
    return { cx: img.width / 2, cy: img.height / 2, r };
  }
  return { cx: bestMid / k, cy: (top + best / 2) / k, r: best / 2 / k };
}

/**
 * Lifts the print off a product photo: the ball's own shading and dimple shadows are
 * normalised away so only the ink remains, then it is re-lit by the 3D renderer.
 */
export function photoDecal(img: CanvasImageSource & { width: number; height: number }): Decal {
  const { cx, cy, r } = findBallCircle(img);
  const c = decalCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2, 0, 0, DECAL, DECAL);
  const id = ctx.getImageData(0, 0, DECAL, DECAL);
  const d = id.data;
  const R = DECAL / 2;
  // The photo's own lighting falls off towards the rim, so the "unprinted white" is measured
  // ring by ring (a high percentile, since ink and dimple shadows are the darker minority).
  const RINGS = 48;
  const samples: number[][] = Array.from({ length: RINGS }, () => []);
  for (let y = 0; y < DECAL; y += 2) {
    for (let x = 0; x < DECAL; x += 2) {
      const rr = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
      const i = (y * DECAL + x) * 4;
      if (rr < 1 && d[i + 3] > 200) samples[Math.min(RINGS - 1, Math.floor(rr * RINGS))].push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
  }
  const ringWhite = samples.map((a) => {
    if (a.length < 8) return 0;
    a.sort((p, q) => p - q);
    return a[Math.floor(a.length * 0.85)];
  });
  // Fill gaps and smooth so the white point changes gently from ring to ring.
  for (let k = 1; k < RINGS; k++) if (!ringWhite[k]) ringWhite[k] = ringWhite[k - 1];
  for (let k = RINGS - 2; k >= 0; k--) if (!ringWhite[k]) ringWhite[k] = ringWhite[k + 1] || 255;
  const white = ringWhite.map((_, k) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, k - 2); j <= Math.min(RINGS - 1, k + 2); j++) {
      sum += ringWhite[j];
      n++;
    }
    return Math.max(40, sum / n);
  });
  for (let y = 0; y < DECAL; y++) {
    for (let x = 0; x < DECAL; x++) {
      const i = (y * DECAL + x) * 4;
      const rr = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
      const w = white[Math.min(RINGS - 1, Math.floor(rr * RINGS))];
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / w;
      // Keep only clearly printed pixels; soft shading and dimple shadows become "no ink".
      const ink = 1 - smooth(0.58, 0.82, lum);
      // Very near the rim the photo is too foreshortened and dark to trust.
      const edge = 1 - smooth(0.86, 0.95, rr);
      const a = d[i + 3] < 128 ? 0 : ink * edge;
      d[i] = Math.min(255, (d[i] / w) * 255);
      d[i + 1] = Math.min(255, (d[i + 1] / w) * 255);
      d[i + 2] = Math.min(255, (d[i + 2] / w) * 255);
      d[i + 3] = Math.round(a * 255);
    }
  }
  return { data: d, mode: 'multiply' };
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ─────────────────────────────── Render ─────────────────────────────── */

export type RenderOptions = { backdrop?: boolean; guide?: boolean; quality?: number };

const LIGHT = (() => {
  const v = [-0.45, 0.55, 0.7];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();
const HALF = (() => {
  const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();

export function ballGeometry(size: number) {
  return { cx: size / 2, cy: size * 0.47, R: size * 0.355 };
}

/** Draws the whole scene (backdrop, floor shadow, lit ball) into a square canvas context. */
export function renderBall(ctx: CanvasRenderingContext2D, size: number, look: BallLook, q: Quat, opts: RenderOptions = {}) {
  const { cx, cy, R } = ballGeometry(size);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (opts.backdrop) {
    const bg = ctx.createRadialGradient(cx, size * 0.32, size * 0.05, cx, size * 0.5, size * 0.78);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.55, '#eceef2');
    bg.addColorStop(1, '#cfd4dc');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  // Floor shadow
  ctx.save();
  ctx.translate(cx, cy + R * 1.04);
  ctx.scale(1, 0.16);
  const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.95);
  sh.addColorStop(0, 'rgba(10,14,24,0.42)');
  sh.addColorStop(0.6, 'rgba(10,14,24,0.14)');
  sh.addColorStop(1, 'rgba(10,14,24,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // The ball itself, possibly at reduced resolution while it is being dragged.
  const quality = opts.quality ?? 1;
  const n = Math.max(16, Math.round(R * 2 * quality));
  const ball = shadeBall(n, look, q, Boolean(opts.guide));
  const off = document.createElement('canvas');
  off.width = off.height = n;
  off.getContext('2d')!.putImageData(ball, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
}

function shadeBall(n: number, look: BallLook, q: Quat, guide: boolean): ImageData {
  const out = new ImageData(n, n);
  const o = out.data;
  const m = qMatrix(q);
  const g = dimpleGrid();
  const base = hexRgb(look.colour);
  const half = n / 2;
  const cosR = Math.cos(DIMPLE_ANGLE);
  const [lx, ly, lz] = LIGHT;
  const [hx, hy, hz] = HALF;

  for (let py = 0; py < n; py++) {
    const y = -((py + 0.5 - half) / half);
    for (let px = 0; px < n; px++) {
      const x = (px + 0.5 - half) / half;
      const d2 = x * x + y * y;
      const rr = Math.sqrt(d2);
      const cover = Math.max(0, Math.min(1, (1 - rr) * half + 0.5));
      if (cover <= 0) continue;
      const z = Math.sqrt(Math.max(0, 1 - d2));
      // view → ball space (transpose of m)
      const bx = m[0] * x + m[3] * y + m[6] * z;
      const by = m[1] * x + m[4] * y + m[7] * z;
      const bz = m[2] * x + m[5] * y + m[8] * z;

      // Albedo with decals
      let ar = base[0];
      let ag = base[1];
      let ab = base[2];
      const decal = bz >= 0 ? look.front : look.back;
      if (decal) {
        const u = bz >= 0 ? bx : -bx;
        const tx = Math.floor((u * 0.5 + 0.5) * DECAL);
        const ty = Math.floor((0.5 - by * 0.5) * DECAL);
        if (tx >= 0 && ty >= 0 && tx < DECAL && ty < DECAL) {
          const i = (ty * DECAL + tx) * 4;
          const a = decal.data[i + 3] / 255;
          if (a > 0) {
            const dr = decal.data[i] / 255;
            const dg = decal.data[i + 1] / 255;
            const db = decal.data[i + 2] / 255;
            if (decal.mode === 'multiply') {
              ar *= 1 - a + a * dr;
              ag *= 1 - a + a * dg;
              ab *= 1 - a + a * db;
            } else {
              ar += (dr - ar) * a;
              ag += (dg - ag) * a;
              ab += (db - ab) * a;
            }
          }
        }
      }
      if (guide && bz > 0) {
        const ur = Math.hypot(bx, by);
        if (Math.abs(ur - PRINT_AREA) < 0.006 && Math.floor((Math.atan2(by, bx) + Math.PI) * 18) % 2 === 0) {
          ar = 0.18;
          ag = 0.5;
          ab = 1;
        }
      }

      // Dimple normal in ball space
      let nx = bx;
      let ny = by;
      let nz = bz;
      const lat = Math.asin(Math.max(-1, Math.min(1, by)));
      const lon = Math.atan2(bz, bx);
      const ga = Math.min(GRID_LAT - 1, Math.floor(((lat + Math.PI / 2) / Math.PI) * GRID_LAT));
      const gb = Math.min(GRID_LON - 1, Math.floor(((lon + Math.PI) / (Math.PI * 2)) * GRID_LON));
      const cell = g[ga * GRID_LON + gb];
      let bestDot = cosR;
      let best = -1;
      for (let k = 0; k < cell.length; k++) {
        const j = cell[k] * 3;
        const dd = bx * DIMPLES[j] + by * DIMPLES[j + 1] + bz * DIMPLES[j + 2];
        if (dd > bestDot) {
          bestDot = dd;
          best = j;
        }
      }
      let cavity = 1;
      if (best >= 0) {
        const th = Math.acos(Math.min(1, bestDot));
        const s = (th / DIMPLE_ANGLE) * DIMPLE_DEPTH;
        let tx = DIMPLES[best] - bestDot * bx;
        let ty = DIMPLES[best + 1] - bestDot * by;
        let tz = DIMPLES[best + 2] - bestDot * bz;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        nx = bx + s * tx;
        ny = by + s * ty;
        nz = bz + s * tz;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        cavity = 0.965 + 0.035 * (th / DIMPLE_ANGLE);
      }
      // ball → view
      const vx = m[0] * nx + m[1] * ny + m[2] * nz;
      const vy = m[3] * nx + m[4] * ny + m[5] * nz;
      const vz = m[6] * nx + m[7] * ny + m[8] * nz;

      const diff = Math.max(0, vx * lx + vy * ly + vz * lz);
      const nh = Math.max(0, vx * hx + vy * hy + vz * hz);
      const spec = Math.pow(nh, 70) * 0.5 + Math.pow(nh, 9) * 0.07;
      const ao = (0.76 + 0.24 * z) * cavity;
      const amb = 0.5 + 0.08 * vy;
      const light = (amb + 0.56 * diff) * ao;

      const i = (py * n + px) * 4;
      o[i] = Math.min(255, (ar * light + spec) * 255);
      o[i + 1] = Math.min(255, (ag * light + spec) * 255);
      o[i + 2] = Math.min(255, (ab * light + spec) * 255);
      o[i + 3] = cover * 255;
    }
  }
  return out;
}

/** Renders the proof (logo side facing, studio backdrop) and returns it as a JPEG for upload. */
export async function renderProof(look: BallLook, size = 900): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  renderBall(canvas.getContext('2d')!, size, look, IDENTITY, { backdrop: true });
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not create the preview image');
  return new File([blob], 'proof.jpg', { type: 'image/jpeg' });
}
