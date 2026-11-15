import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireBusiness } from '@/lib/business-lock';
import { shopifyAuthorizeUrl, shopifyConfig, shopifyRedirectUri } from '@/lib/shopify';
import { appUrl, newToken } from '@/lib/tokens';

/** Owner only: sends them to Shopify to approve COS's read-only access (once). */
export async function GET() {
  await requireBusiness({ renew: true });
  if (!shopifyConfig()) redirect('/business/stock?shopify=missing');
  const state = newToken();
  (await cookies()).set('cos_shopify_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/shopify', maxAge: 600 });
  redirect(shopifyAuthorizeUrl(state, shopifyRedirectUri(appUrl)));
}
