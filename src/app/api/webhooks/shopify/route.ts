import { storeDomain, verifyShopifyWebhook } from '@/lib/shopify-admin';
import { markShopifyOrderPaid, type ShopifyOrderWebhook } from '@/lib/services/shopify-invoices';

/**
 * Shopify → COS: "orders/paid" (or "orders/create"). Checked by Shopify's HMAC signature before
 * anything is read. A paid order carrying a "COS invoice" attribute puts its designs into print.
 * Always answers 200 for orders that aren't ours, so Shopify doesn't keep retrying them.
 */
export async function POST(req: Request) {
  const body = await req.text();
  if (!verifyShopifyWebhook(body, req.headers.get('x-shopify-hmac-sha256'))) return new Response('Invalid signature', { status: 401 });
  const shop = req.headers.get('x-shopify-shop-domain')?.toLowerCase();
  const ours = storeDomain();
  if (ours && shop && shop !== ours) return new Response('Wrong store', { status: 401 });
  const topic = req.headers.get('x-shopify-topic') ?? '';
  if (!['orders/paid', 'orders/create'].includes(topic)) return Response.json({ ok: true, ignored: topic });
  let order: ShopifyOrderWebhook;
  try {
    order = JSON.parse(body) as ShopifyOrderWebhook;
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  const r = await markShopifyOrderPaid(order);
  if (r.matched && r.warnings.length) console.warn('[COS Shopify payment]', r.invoiceId, r.warnings.join(' | '));
  return Response.json({ ok: true, ...r });
}
