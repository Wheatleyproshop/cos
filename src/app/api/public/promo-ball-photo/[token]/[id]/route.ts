import { findBallPromotion } from '@/lib/services/ball-promotions';
import { storage } from '@/lib/storage';

/** Ball photos for a promotion page: only balls that are in that promotion. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const found = await findBallPromotion(token);
  const b = found?.balls.find((x) => x.id === id);
  if (!b?.photoKey || !b.photoMime) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await storage().get(b.photoKey)), {
    headers: {
      'Content-Type': b.photoMime,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
