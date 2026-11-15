import { safeEqual } from '@/lib/tokens';
import { shopifyConfig } from '@/lib/shopify';
import { syncShopifySales } from '@/lib/services/business/shopify-sales';
import { syncShopifyStock } from '@/lib/services/business/shopify-sync';

export const maxDuration = 300;

/** Vercel Cron (nightly): pull products, costs and stock levels from Shopify. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new Response('Unauthorised', { status: 401 });
  if (!shopifyConfig()) return Response.json({ ok: true, skipped: 'Shopify not connected' });
  const started = Date.now();
  try {
    const stock = await syncShopifyStock();
    // Sales next, with whatever time is left (a big first export carries on tomorrow).
    const sales = await syncShopifySales({ waitMs: Math.max(20_000, 270_000 - (Date.now() - started)) }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ok: true, stock, sales });
  } catch (e) {
    console.error('[COS shopify sync]', e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
