/**
 * Read-only connection to the shop's own Shopify store, via a Dev Dashboard app in the same Shopify
 * organisation (client credentials grant). Set in the hosting environment, never in code:
 *   SHOPIFY_SHOP (subdomain, e.g. "desirable-golf-online-store"), SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
 * Optional: SHOPIFY_COS_ORG (the COS organisation slug the store belongs to; default "desirable-golf").
 */

import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { systemDb } from '@/db';
import { organisations } from '@/db/schema';
import { decryptSecret, encryptSecret, safeEqual } from './tokens';

const API_VERSION = '2026-10';
/**
 * Read-only: products and costs, stock levels, and orders (for sales). SHOPIFY_EXTRA_SCOPES adds more
 * when the owner reconnects, e.g. "write_draft_orders" for pay-before-print invoices.
 */
export const SHOPIFY_SCOPES = ['read_products,read_inventory,read_orders,read_all_orders', process.env.SHOPIFY_EXTRA_SCOPES?.replace(/\s+/g, '')]
  .filter(Boolean)
  .join(',');

export function shopifyConfig() {
  const shop = process.env.SHOPIFY_SHOP?.trim().replace(/\.myshopify\.com$/, '');
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!shop || !clientId || !clientSecret || !/^[a-z0-9-]+$/.test(shop)) return null;
  return { shop, clientId, clientSecret, orgSlug: process.env.SHOPIFY_COS_ORG?.trim() || 'desirable-golf' };
}

let cached: { token: string; until: number } | null = null;

/** The permanent read-only token from "Connect to Shopify", if the owner has approved it. */
async function storedToken(orgSlug: string) {
  const [org] = await systemDb().select({ t: organisations.shopifyTokenEncrypted }).from(organisations).where(eq(organisations.slug, orgSlug)).limit(1);
  return org?.t ? decryptSecret(org.t) : null;
}

export async function shopifyAuthorised() {
  const cfg = shopifyConfig();
  return Boolean(cfg && (await storedToken(cfg.orgSlug)));
}

/**
 * Two ways in: the token saved by the one-time approval (works for any store), or — when the app and
 * the store are in the same Shopify organisation — a 24-hour token from the client credentials grant.
 */
/** A token for Admin API calls (exported for the pay-before-print invoices). */
export async function shopifyAccessToken() {
  return accessToken();
}

async function accessToken() {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t connected yet.');
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const saved = await storedToken(cfg.orgSlug);
  if (saved) {
    cached = { token: saved, until: Date.now() + 10 * 60_000 };
    return saved;
  }
  const res = await fetch(`https://${cfg.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; errors?: string };
  if (!res.ok || !json.access_token) {
    throw new ShopifyError(`Not connected to Shopify yet — press “Connect to Shopify” on the Stock page and approve read-only access (${json.error_description ?? json.errors ?? res.status}).`);
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

/* ───────────── One-time approval (Shopify's authorization code flow) ───────────── */

export function shopifyRedirectUri(appUrl: (p: string) => string) {
  return appUrl('/api/shopify/callback');
}

export function shopifyAuthorizeUrl(state: string, redirectUri: string) {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Add the Shopify app details in Vercel first.');
  const q = new URLSearchParams({ client_id: cfg.clientId, scope: SHOPIFY_SCOPES, redirect_uri: redirectUri, state });
  return `https://${cfg.shop}.myshopify.com/admin/oauth/authorize?${q}`;
}

/**
 * Shopify signs the callback: HMAC-SHA256 (hex) of the other query parameters, sorted by name and
 * re-encoded as a query string — the same way Shopify's own library checks it. The plain (decoded)
 * form is accepted too, as both appear in Shopify's documentation.
 */
export function verifyShopifyHmac(params: URLSearchParams) {
  const cfg = shopifyConfig();
  const hmac = params.get('hmac');
  if (!cfg || !hmac) return false;
  const rest = [...params.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sign = (msg: string) => createHmac('sha256', cfg.clientSecret).update(msg).digest('hex');
  const encoded = new URLSearchParams(rest).toString();
  const plain = rest.map(([k, v]) => `${k}=${v}`).join('&');
  return safeEqual(sign(encoded), hmac) || safeEqual(sign(plain), hmac);
}

/** Swaps the approval code for a permanent read-only token and saves it (encrypted). */
export async function exchangeShopifyCode(code: string) {
  const cfg = shopifyConfig();
  if (!cfg) throw new ShopifyError('Shopify isn’t set up.');
  const res = await fetch(`https://${cfg.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
  if (!res.ok || !json.access_token) throw new ShopifyError('Shopify didn’t complete the connection. Please try again.');
  // With full order history newly granted, start the sales sync again from the beginning (lines are
  // upserted, so nothing is counted twice).
  const fullHistory = (json.scope ?? '').split(',').includes('read_all_orders');
  await systemDb()
    .update(organisations)
    .set({ shopifyTokenEncrypted: encryptSecret(json.access_token), ...(fullHistory ? { shopifySync: {} } : {}) })
    .where(eq(organisations.slug, cfg.orgSlug));
  cached = null;
  return { scope: json.scope ?? '' };
}
