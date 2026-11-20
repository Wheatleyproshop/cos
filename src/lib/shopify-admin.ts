/**
 * Pay before print: the Shopify calls that create and email the invoice, and the webhook check.
 *
 * Everything comes from the hosting environment, never from code:
 *   SHOPIFY_INVOICES        "live" to really create and email Shopify invoices. Anything else (or
 *                           unset) = test mode: COS works out the invoice and shows it, but sends nothing.
 *   SHOPIFY_STORE_DOMAIN    e.g. desirable-golf-online-store.myshopify.com (falls back to SHOPIFY_SHOP).
 *   SHOPIFY_ADMIN_TOKEN     Admin API access token with write_draft_orders + read_products. Optional:
 *                           without it COS uses its existing Shopify connection (which then needs
 *                           write_draft_orders added; see docs/PAY_BEFORE_PRINT.md).
 *   SHOPIFY_WEBHOOK_SECRET  the key Shopify signs webhooks with (falls back to SHOPIFY_CLIENT_SECRET,
 *                           which is what Shopify uses for webhooks registered by the app itself).
 *   SHOPIFY_API_VERSION     optional, default 2026-10.
 */

import { createHmac } from 'node:crypto';
import { shopifyAccessToken, shopifyConfig } from './shopify';
import { e164, handleFor, splitName, type DraftOrderInput, type ShopifyVariant } from './shopify-invoice';
import { safeEqual } from './tokens';

export class ShopifyInvoiceError extends Error {}

export type InvoiceMode = 'live' | 'dry_run';
export const invoiceMode = (): InvoiceMode => (process.env.SHOPIFY_INVOICES?.trim().toLowerCase() === 'live' ? 'live' : 'dry_run');

export function storeDomain(): string | null {
  const raw = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!raw) return null;
  const domain = raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`;
  return /^[a-z0-9-]+\.myshopify\.com$/.test(domain) ? domain : null;
}

const apiVersion = () => (/^\d{4}-\d{2}$/.test(process.env.SHOPIFY_API_VERSION?.trim() ?? '') ? process.env.SHOPIFY_API_VERSION!.trim() : '2026-10');

async function token() {
  const own = process.env.SHOPIFY_ADMIN_TOKEN?.trim();
  if (own) return own;
  if (shopifyConfig()) return shopifyAccessToken();
  throw new ShopifyInvoiceError('Shopify invoices aren’t set up yet: add SHOPIFY_ADMIN_TOKEN (or connect Shopify) in the hosting settings.');
}

/** What's missing before live invoices can work, in plain words (empty = ready). */
export function invoiceSetupProblems(): string[] {
  const out: string[] = [];
  if (!storeDomain()) out.push('SHOPIFY_STORE_DOMAIN is not set');
  if (!process.env.SHOPIFY_ADMIN_TOKEN?.trim() && !shopifyConfig()) out.push('no Shopify access token (SHOPIFY_ADMIN_TOKEN)');
  if (!webhookSecrets().length) out.push('SHOPIFY_WEBHOOK_SECRET is not set, so payments can’t be matched back');
  return out;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const domain = storeDomain();
  if (!domain) throw new ShopifyInvoiceError('SHOPIFY_STORE_DOMAIN isn’t set.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://${domain}/admin/api/${apiVersion()}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyInvoiceError('Shopify refused the access token. Check SHOPIFY_ADMIN_TOKEN and that the app has write_draft_orders.');
    const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message).join('; ');
      if (/access denied|scope/i.test(msg)) throw new ShopifyInvoiceError(`The Shopify app is missing a permission (needs write_draft_orders, read_products, read_customers and write_customers): ${msg}`);
      throw new ShopifyInvoiceError(`Shopify said: ${msg}`);
    }
    return json.data as T;
  }
  throw new ShopifyInvoiceError('Shopify is busy. Try again in a minute.');
}

const toPence = (v: string | null | undefined) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

/** Looks up the ball products by handle (e.g. pro-v1, pro-v1x, pro-v1x-left-dash). */
export async function findVariantsByHandle(ballNames: string[]): Promise<ShopifyVariant[]> {
  const handles = [...new Set(ballNames.map(handleFor).filter(Boolean))];
  if (!handles.length) return [];
  type P = { handle: string; title: string; variants: { nodes: { id: string; title: string; price: string; compareAtPrice: string | null }[] } };
  const data = await gql<{ products: { nodes: P[] } }>(
    `query Balls($q: String!) { products(first: 25, query: $q) { nodes { handle title variants(first: 10) { nodes { id title price compareAtPrice } } } } }`,
    { q: handles.map((h) => `handle:${h}`).join(' OR ') },
  );
  return data.products.nodes
    .filter((p) => handles.includes(p.handle))
    .flatMap((p) =>
      p.variants.nodes.map((v) => ({
        handle: p.handle, variantId: v.id, title: v.title && v.title !== 'Default Title' ? `${p.title} – ${v.title}` : p.title,
        pricePence: toPence(v.price) ?? 0, compareAtPence: toPence(v.compareAtPrice),
      })),
    );
}

type UserErrors = { field: string[] | null; message: string }[];
const errText = (e: UserErrors) => e.map((x) => x.message).join('; ');

/**
 * The Shopify customer for this invoice: found by email, or created from the COS name, email and
 * phone, so the order shows their details without retyping (needs read_customers / write_customers).
 */
export async function findOrCreateCustomer(c: { name: string; email: string; phone: string }): Promise<{ id: string; created: boolean }> {
  const email = c.email.trim().toLowerCase();
  const found = await gql<{ customers: { nodes: { id: string; email: string | null }[] } }>(
    `query Find($q: String!) { customers(first: 5, query: $q) { nodes { id email } } }`,
    { q: `email:"${email.replace(/["\\]/g, '')}"` },
  );
  const hit = found.customers.nodes.find((n) => n.email?.toLowerCase() === email);
  if (hit) return { id: hit.id, created: false };
  const create = async (withPhone: boolean) =>
    (
      await gql<{ customerCreate: { customer: { id: string } | null; userErrors: UserErrors } }>(
        `mutation New($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
        { input: { ...splitName(c.name), email, ...(withPhone && e164(c.phone) ? { phone: e164(c.phone) } : {}) } },
      )
    ).customerCreate;
  let r = await create(true);
  // A phone number already on another Shopify customer is rejected; the email alone is enough.
  if (r.userErrors.length && r.userErrors.some((e) => e.field?.includes('phone'))) r = await create(false);
  if (r.userErrors.length || !r.customer) throw new ShopifyInvoiceError(`Shopify didn’t add the customer: ${errText(r.userErrors) || 'no customer returned'}`);
  return { id: r.customer.id, created: true };
}

export async function createDraftOrder(input: DraftOrderInput) {
  const data = await gql<{
    draftOrderCreate: { draftOrder: { id: string; name: string; invoiceUrl: string; status: string; totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: UserErrors };
  }>(
    `mutation Create($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name invoiceUrl status totalPriceSet { shopMoney { amount } } }
        userErrors { field message }
      }
    }`,
    { input },
  );
  const r = data.draftOrderCreate;
  if (r.userErrors.length || !r.draftOrder) throw new ShopifyInvoiceError(`Shopify didn’t create the invoice: ${errText(r.userErrors) || 'no draft order returned'}`);
  return { ...r.draftOrder, totalPence: toPence(r.draftOrder.totalPriceSet.shopMoney.amount) ?? 0 };
}

export async function sendDraftOrderInvoice(id: string) {
  const data = await gql<{ draftOrderInvoiceSend: { draftOrder: { id: string; invoiceSentAt: string | null } | null; userErrors: UserErrors } }>(
    `mutation Send($id: ID!) { draftOrderInvoiceSend(id: $id) { draftOrder { id invoiceSentAt } userErrors { field message } } }`,
    { id },
  );
  const r = data.draftOrderInvoiceSend;
  if (r.userErrors.length) throw new ShopifyInvoiceError(`Shopify created the draft order but didn’t email it: ${errText(r.userErrors)}`);
  return r.draftOrder;
}

/** Removes a draft order COS created but won't use (e.g. the total didn't match). */
export async function deleteDraftOrder(id: string) {
  await gql(`mutation Del($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }`, { input: { id } }).catch(() => null);
}

/* ─────────────────────────────── Webhooks ─────────────────────────────── */

/**
 * Subscribes the app to "order paid" → COS's webhook address. Created through the app, so Shopify
 * signs it with the app's client secret (already in the hosting settings): nobody copies a key.
 * Safe to repeat: an existing subscription for the same address counts as done.
 */
export async function ensurePaidWebhook(address: string): Promise<'created' | 'exists'> {
  const run = (field: 'uri' | 'callbackUrl') =>
    gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: UserErrors } }>(
      `mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
      }`,
      { topic: 'ORDERS_PAID', sub: { [field]: address, format: 'JSON' } },
    );
  let r;
  try {
    r = (await run('uri')).webhookSubscriptionCreate;
  } catch (e) {
    // Older API versions call the address field callbackUrl.
    if (!(e instanceof ShopifyInvoiceError) || !/uri/i.test(e.message)) throw e;
    r = (await run('callbackUrl')).webhookSubscriptionCreate;
  }
  if (r.webhookSubscription) return 'created';
  if (r.userErrors.some((u) => /already been taken|already exists/i.test(u.message))) return 'exists';
  throw new ShopifyInvoiceError(`Shopify didn’t set up the payment notification: ${errText(r.userErrors)}`);
}

function webhookSecrets() {
  return [process.env.SHOPIFY_WEBHOOK_SECRET?.trim(), process.env.SHOPIFY_CLIENT_SECRET?.trim()].filter((s): s is string => Boolean(s));
}

/** Shopify signs each webhook: base64 HMAC-SHA256 of the raw body (header X-Shopify-Hmac-Sha256). */
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null, secrets = webhookSecrets()) {
  if (!hmacHeader || !secrets.length) return false;
  return secrets.some((s) => safeEqual(createHmac('sha256', s).update(rawBody, 'utf8').digest('base64'), hmacHeader.trim()));
}
