import { INK_COLOURS, PRINT_FONTS, type InkKey, type PrintFontKey } from '@/lib/ball-print';

/**
 * Photographic-style golf ball renderer for the Ball Printing builder and the emailed proof.
 * Pure canvas (no images to license): studio backdrop, soft floor shadow, foreshortened
 * dimples, lighting and a specular highlight, with the artwork printed under the lighting
 * so it sits on the ball rather than floating over it.
 */
export type BallArtwork =
  | { type: 'logo'; image: CanvasImageSource & { width: number; height: number }; scale: number }
  | { type: 'text'; lines: string[]; font: PrintFontKey; ink: InkKey; scale: number }
  | null;

export type BallScene = {
  colour: string;
  brand: string;
  model: string;
  view: 'logo' | 'brand';
  artwork: BallArtwork;
  backdrop?: boolean;
  guide?: boolean;
};

// Fibonacci sphere: an even dimple layout, computed once.
const DIMPLES = (() => {
  const n = 352;
  const pts: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    pts.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return pts;
})();

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function drawBall(ctx: CanvasRenderingContext2D, size: number, s: BallScene) {
  const W = size;
  const cx = W / 2;
  const cy = W * 0.47;
  const R = W * 0.355;
  ctx.save();
  ctx.clearRect(0, 0, W, W);

  if (s.backdrop !== false) {
    const bg = ctx.createRadialGradient(cx, W * 0.32, W * 0.05, cx, W * 0.5, W * 0.78);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.55, '#eceef2');
    bg.addColorStop(1, '#cfd4dc');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, W);
  }

  // Floor shadow
  const sy = cy + R * 1.04;
  ctx.save();
  ctx.translate(cx, sy);
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

  // Ball body
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = s.colour;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  const light = luminance(s.colour) > 0.55;
  if (s.view === 'logo') drawArtwork(ctx, cx, cy, R, s.artwork, light);
  else drawSidestamp(ctx, cx, cy, R, s.brand, s.model, light);

  // Dimples: a dark crescent on the upper-left wall, a lit lower-right wall.
  const d = R * 0.093;
  for (const [x, y, z] of DIMPLES) {
    if (z < 0.04) continue;
    const px = cx + x * R;
    const py = cy - y * R;
    const ang = Math.atan2(-y, x);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(Math.max(z, 0.12), 1);
    ctx.beginPath();
    ctx.arc(0, 0, d, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(20,26,40,${0.035 + 0.05 * z})`;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(px + d * 0.12, py + d * 0.12);
    ctx.rotate(ang);
    ctx.scale(Math.max(z, 0.12), 1);
    ctx.beginPath();
    ctx.arc(0, 0, d * 0.84, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.07 + 0.12 * z})`;
    ctx.fill();
    ctx.restore();
  }

  // Key light from the upper left, falling off to the rim.
  const shade = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.42, R * 0.1, cx, cy, R * 1.02);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(0.82, 'rgba(10,16,30,0.13)');
  shade.addColorStop(1, 'rgba(10,16,30,0.38)');
  ctx.fillStyle = shade;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // Bounce light from the floor along the lower rim.
  const bounce = ctx.createRadialGradient(cx + R * 0.1, cy + R * 1.25, R * 0.2, cx + R * 0.1, cy + R * 1.25, R * 0.75);
  bounce.addColorStop(0, 'rgba(255,255,255,0.20)');
  bounce.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bounce;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // Specular highlight
  const spec = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, 0, cx - R * 0.4, cy - R * 0.45, R * 0.42);
  spec.addColorStop(0, 'rgba(255,255,255,0.85)');
  spec.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();

  if (s.guide && s.view === 'logo') {
    ctx.save();
    ctx.setLineDash([R * 0.04, R * 0.035]);
    ctx.lineWidth = Math.max(1, R * 0.008);
    ctx.strokeStyle = 'rgba(47,128,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** The printable area is roughly a circle 60% of the ball's diameter, like the tour print tools. */
function drawArtwork(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, art: BallArtwork, lightBall: boolean) {
  if (!art) return;
  const maxW = R * 1.15 * art.scale;
  ctx.save();
  // Multiply lets white logo backgrounds disappear into the ball, as pad printing does.
  if (lightBall) ctx.globalCompositeOperation = 'multiply';
  if (art.type === 'logo') {
    const { image } = art;
    const k = Math.min(maxW / image.width, maxW / image.height);
    const w = image.width * k;
    const h = image.height * k;
    ctx.drawImage(image, cx - w / 2, cy - h / 2, w, h);
  } else {
    const lines = art.lines.map((l) => l.trim()).filter(Boolean);
    if (lines.length) {
      const tpl = PRINT_FONTS.find((f) => f.key === art.font)?.css ?? PRINT_FONTS[0].css;
      let px = R * 0.42 * art.scale * (lines.length === 1 ? 1.15 : lines.length === 2 ? 0.95 : 0.8);
      const fit = () => {
        ctx.font = tpl.replace('{size}', px.toFixed(1));
        return Math.max(...lines.map((l) => ctx.measureText(l).width));
      };
      while (fit() > maxW && px > 4) px *= 0.94;
      ctx.fillStyle = INK_COLOURS.find((c) => c.key === art.ink)?.hex ?? '#111';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lh = px * 1.18;
      lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * lh));
    }
  }
  ctx.restore();
}

function drawSidestamp(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, brand: string, model: string, lightBall: boolean) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = lightBall ? '#14161c' : '#ffffff';
  let px = R * 0.26;
  ctx.font = `italic 700 ${px}px Georgia, "Times New Roman", serif`;
  while (ctx.measureText(brand).width > R * 1.25 && px > 6) {
    px *= 0.94;
    ctx.font = `italic 700 ${px}px Georgia, "Times New Roman", serif`;
  }
  ctx.fillText(brand, cx, cy - R * 0.1);
  ctx.font = `700 ${R * 0.13}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = lightBall ? '#c8102e' : '#ffffff';
  ctx.fillText(model.toUpperCase(), cx, cy + R * 0.2);
  ctx.restore();
}

/** Renders the proof at email resolution and returns it as a JPEG file for upload. */
export async function renderProof(scene: BallScene, size = 900): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  drawBall(canvas.getContext('2d')!, size, { ...scene, view: 'logo', guide: false, backdrop: true });
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not create the preview image');
  return new File([blob], 'proof.jpg', { type: 'image/jpeg' });
}
