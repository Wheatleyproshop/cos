import { ImageResponse } from 'next/og';
import { IconTile, iconSvg } from '@/lib/app-icon';

const PNG: Record<string, { size: number; pad?: number; rounded?: boolean }> = {
  'icon-192.png': { size: 192 },
  'icon-512.png': { size: 512 },
  'maskable-512.png': { size: 512, pad: 0.1, rounded: false },
  // iOS applies its own rounded mask.
  'apple-180.png': { size: 180, rounded: false },
};

export async function GET(_: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const cache = { 'Cache-Control': 'public, max-age=86400' };
  if (name === 'icon.svg') return new Response(iconSvg(), { headers: { 'Content-Type': 'image/svg+xml', ...cache } });
  const spec = PNG[name];
  if (!spec) return new Response('Not found', { status: 404 });
  return new ImageResponse(<IconTile {...spec} />, { width: spec.size, height: spec.size, headers: cache });
}
