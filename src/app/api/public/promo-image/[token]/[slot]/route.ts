import { findBallPromotion } from '@/lib/services/ball-promotions';
import { storage } from '@/lib/storage';

/** A promotion's campaign images (banner and feature), for its public page. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; slot: string }> }) {
  const { token, slot } = await params;
  if (slot !== 'banner' && slot !== 'feature') return new Response('Not found', { status: 404 });
  const found = await findBallPromotion(token);
  const key = slot === 'banner' ? found?.promo.bannerKey : found?.promo.featureKey;
  const mime = slot === 'banner' ? found?.promo.bannerMime : found?.promo.featureMime;
  if (!key || !mime) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await storage().get(key)), {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
