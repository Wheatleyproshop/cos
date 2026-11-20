import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getStaff } from '@/lib/auth';
import { canSeeBusiness, requireBusiness, validShopifyConnectPass } from '@/lib/business-lock';
import { shopifyAuthorizeUrl, shopifyConfig, shopifyRedirectUri } from '@/lib/shopify';
import { appUrl, newToken } from '@/lib/tokens';

/**
 * Owner only: sends them to Shopify to approve COS's access. The Business area locks as the owner
 * leaves the Stock page, so the button carries a short-lived pass from that (unlocked) page.
 */
export async function GET(req: Request) {
  const staff = await getStaff();
  const pass = new URL(req.url).searchParams.get('pass');
  if (!(staff && canSeeBusiness(staff) && validShopifyConnectPass(staff.id, pass))) await requireBusiness({ renew: true });
  if (!shopifyConfig()) redirect('/business/stock?shopify=missing');
  const state = newToken();
  (await cookies()).set('cos_shopify_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/shopify', maxAge: 600 });
  redirect(shopifyAuthorizeUrl(state, shopifyRedirectUri(appUrl)));
}
