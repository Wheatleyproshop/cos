import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withTenant } from '@/db';
import { ctxFor } from '@/lib/action-utils';
import { recordEvent } from '@/lib/audit';
import { getStaff } from '@/lib/auth';
import { canSeeBusiness } from '@/lib/business-lock';
import { exchangeShopifyCode, shopifyConfig, ShopifyError, verifyShopifyHmac } from '@/lib/shopify';
import { appUrl, safeEqual } from '@/lib/tokens';
import { ensurePaidWebhook } from '@/lib/shopify-admin';

/**
 * Shopify sends the owner back here after they approve access. Checked three ways before anything is
 * saved: it's the owner signed in to COS, the state matches the one we set, and Shopify's signature is valid.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams;
  const staff = await getStaff();
  const jar = await cookies();
  const expected = jar.get('cos_shopify_state')?.value;
  jar.delete('cos_shopify_state');
  const cfg = shopifyConfig();
  const fail = (why: string) => redirect(`/business/stock?shopify=${encodeURIComponent(why)}`);
  if (!staff || !canSeeBusiness(staff)) return new Response('Only the owner can connect Shopify.', { status: 403 });
  if (!cfg) return fail('missing');
  if (!expected || !safeEqual(expected, p.get('state') ?? '')) return fail('expired');
  if (!verifyShopifyHmac(p)) return fail('signature');
  if (p.get('shop') !== `${cfg.shop}.myshopify.com`) return fail('wrong-store');
  const code = p.get('code');
  if (!code) return fail('cancelled');
  let paymentsHook: string | null = null;
  try {
    const r = await exchangeShopifyCode(code);
    // Pay before print: with draft-order access granted, make sure Shopify tells COS when invoices are paid.
    if (r.scope.split(',').includes('write_draft_orders')) {
      paymentsHook = await ensurePaidWebhook(appUrl('/api/webhooks/shopify')).catch((e: Error) => {
        console.error('[COS Shopify payment webhook]', e.message);
        return `failed: ${e.message}`.slice(0, 300);
      });
    }
    const ctx = ctxFor(staff);
    await withTenant(staff.organisationId, (tx) =>
      recordEvent(tx, {
        organisationId: staff.organisationId, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: staff.organisationId,
        metadata: { section: 'shopify.connected', shop: cfg.shop, scope: r.scope, paymentsWebhook: paymentsHook },
      }),
    );
  } catch (e) {
    if (e instanceof ShopifyError) return fail('exchange');
    throw e;
  }
  redirect(`/business/stock?shopify=connected${paymentsHook ? `&payments=${paymentsHook.startsWith('failed') ? 'failed' : 'ok'}` : ''}`);
}
