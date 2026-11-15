/**
 * Read-only connection to the shop's own Shopify store, via a Dev Dashboard app in the same Shopify
 * organisation (client credentials grant). Set in the hosting environment, never in code:
 *   SHOPIFY_SHOP (subdomain, e.g. "desirable-golf-online-store"), SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
 * Optional: SHOPIFY_COS_ORG (the COS organisation slug the store belongs to; default "desirable-golf").
 */

const API_VERSION = '2026-01';

export function shopifyConfig() {
  const shop = process.env.SHOPIFY_SHOP?.trim().replace(/\.myshopify\.com$/, '');
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!shop || !clientId || !clientSecret || !/^[a-z0-9-]+$/.test(shop)) return null;
  return { shop, clientId, clientSecret, orgSlug: process.env.SHOPIFY_COS_ORG?.trim() || 'desirable-golf' };
}

let cached: { token: string; until: number } | null = null;

async function accessToken() {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t connected yet.');
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch(`https://${cfg.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; errors?: string };
  if (!res.ok || !json.access_token) {
    throw new ShopifyError(`Shopify didn’t accept the app details (${json.error_description ?? json.errors ?? res.status}). Check the Client ID/secret and that the app is installed on the store.`);
  }
  cached = { token: json.access_token, until: Date.now() + (json.expires_in ?? 86_399) * 1000 };
  return cached.token;
}

export class ShopifyError extends Error {}

/** One GraphQL Admin API call, waiting and retrying politely when Shopify says to slow down. */
export async function shopifyGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t connected yet.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://${cfg.shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) {
      cached = null;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const json = (await res.json()) as {
      data?: T; errors?: { message: string; extensions?: { code?: string } }[];
      extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
    };
    if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message).join('; ');
      if (/access denied|scope/i.test(msg)) throw new ShopifyError(`The app needs read access to products and inventory (${msg}).`);
      throw new ShopifyError(msg);
    }
    // Stay under the rate limit: if the bucket is getting low, wait for it to refill a little.
    const t = json.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < 300) await new Promise((r) => setTimeout(r, Math.ceil(((300 - t.currentlyAvailable) / Math.max(1, t.restoreRate)) * 1000)));
    return json.data as T;
  }
  throw new ShopifyError('Shopify is busy — try again in a few minutes.');
}
