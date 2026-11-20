/**
 * Pay before print: builds the Shopify draft order (the invoice) for approved ball designs.
 *
 * Pure functions only, no database or network, so the exact payload can be tested and shown to
 * staff in test mode ("dry run") before anything is sent to Shopify.
 *
 * Pricing rule: the invoice total equals what COS showed the customer for each design. When one
 * invoice covers several designs from the same promotion with a multi-buy (e.g. 1 dozen Pro V1 and
 * 1 dozen Pro V1x on "2 dozen for £80"), the multi-buy is applied to the combined dozens, so the
 * customer pays the promotion price for the lot (never more than COS showed them).
 */

import { asBallPrintSpec, ballsPrice, type MultiBuy } from './ball-print';

/** A ball design (COS quote) going on the invoice. */
export type InvoiceDesign = {
  quoteId: string;
  quoteNumber: string;
  ball: { brand: string; name: string };
  dozens: number;
  pricePerDozenPence: number;
  setupFeePence: number;
  /** The quote total COS showed the customer (respects any staff edit to the price). */
  quoteTotalPence: number;
  /** "Text: Happy Christmas Dad" or "Logo: club-crest.png". */
  personalisation: string;
  /** The COS reference on the invoice: the order number once there is one (e.g. COS-1043), else the quote. */
  reference?: string;
  /** Link back to the job in COS. */
  cosUrl?: string;
  proofUrl: string | null;
  logoUrl: string | null;
  promo?: { id: string; title: string; multiBuy?: MultiBuy | null } | null;
};

/** A Shopify product variant found by handle. Prices in pence. */
export type ShopifyVariant = { handle: string; variantId: string; title: string; pricePence: number; compareAtPence: number | null };

export type InvoiceCustomer = { name: string; email: string; phone: string; address?: Omit<ShippingAddress, 'firstName' | 'lastName' | 'phone'> | null };

type Attr = { key: string; value: string };
type Money = { amount: string; currencyCode: 'GBP' };
export type DraftLineItem =
  | { variantId: string; quantity: number; customAttributes: Attr[] }
  | { title: string; quantity: number; originalUnitPriceWithCurrency: Money; requiresShipping: boolean; taxable: boolean; customAttributes: Attr[] };

export type DraftOrderInput = {
  email: string;
  phone?: string;
  note: string;
  tags: string[];
  customAttributes: Attr[];
  lineItems: DraftLineItem[];
  appliedDiscount?: { title: string; description: string; value: number; valueType: 'FIXED_AMOUNT' };
  shippingAddress?: ShippingAddress;
  /** The Shopify customer (found or created from the COS details), so nothing is retyped. */
  purchasingEntity?: { customerId: string };
  /** Off: the store's automatic "2 dozen for £80" discount must not be added on top of ours. */
  acceptAutomaticDiscounts: false;
};

export type ShippingAddress = {
  firstName: string; lastName: string; address1: string; address2?: string; city: string; zip: string; countryCode: string; phone?: string;
};

export const PRINT_TAG = 'personalised-print';

/** First name / last name for Shopify from a single COS name. */
export function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: parts[0] ?? '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** One line of the invoice in plain terms, for staff to check (and for tests). */
export type InvoiceLine = { label: string; quantity: number; unitPence: number; shopifyProduct: boolean; note?: string };

export type InvoicePlan = {
  input: DraftOrderInput;
  lines: InvoiceLine[];
  subtotalPence: number;
  discountPence: number;
  /** What the customer will pay on Shopify, before the postage or collection they choose at checkout. */
  totalPence: number;
  /** The sum of the COS quote totals the customer was shown. */
  cosTotalPence: number;
  /** Anything staff should know before sending (e.g. a ball with no Shopify product). */
  warnings: string[];
};

/** Key put on the draft order (and copied by Shopify onto the paid order) to match the payment back. */
export const COS_INVOICE_ATTR = 'COS invoice';

/** Shopify handle for a print ball: "Pro V1x Left Dash" → "pro-v1x-left-dash". */
export const handleFor = (ballName: string) =>
  ballName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The Desirable Golf variants as they were set up for the Titleist promotion. Only used in test mode
 * when COS can't ask Shopify; the live flow always looks products up by handle.
 */
export const KNOWN_PROMO_VARIANTS: ShopifyVariant[] = [
  { handle: 'pro-v1', variantId: 'gid://shopify/ProductVariant/54890192109948', title: 'Titleist Pro V1', pricePence: 4500, compareAtPence: 5000 },
  { handle: 'pro-v1x', variantId: 'gid://shopify/ProductVariant/54890235625852', title: 'Titleist Pro V1x', pricePence: 4500, compareAtPence: 5000 },
  { handle: 'pro-v1x-left-dash', variantId: 'gid://shopify/ProductVariant/54906911981948', title: 'Titleist Pro V1x Left Dash', pricePence: 4500, compareAtPence: 5000 },
];

const pounds = (pence: number) => (pence / 100).toFixed(2);
const gbp = (pence: number): Money => ({ amount: pounds(pence), currencyCode: 'GBP' });
const fmt = (pence: number) => `£${pounds(pence)}`;

/** Shopify only accepts phone numbers in international form. UK numbers are converted; anything else is left off (it's still in the note). */
export function e164(phone: string): string | null {
  const p = phone.replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(p)) return p;
  if (/^0044\d{9,10}$/.test(p)) return `+${p.slice(2)}`;
  if (/^0\d{9,10}$/.test(p)) return `+44${p.slice(1)}`;
  return null;
}

/** Price of a design on its own, as COS worked it out (balls with any multi-buy, plus setup). */
const designPrice = (d: InvoiceDesign) => ballsPrice(d.dozens, d.pricePerDozenPence, d.promo?.multiBuy).total + d.setupFeePence;

/**
 * How much less the designs cost together than separately, thanks to a promotion multi-buy applied
 * across the combined dozens. Only combines designs on the same promotion at the same dozen price.
 */
function combinedSaving(designs: InvoiceDesign[]) {
  const groups = new Map<string, InvoiceDesign[]>();
  for (const d of designs) {
    const mb = d.promo?.multiBuy;
    if (!d.promo || !mb) continue;
    const key = `${d.promo.id}|${d.pricePerDozenPence}|${mb.dozens}|${mb.pricePence}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  let saving = 0;
  const titles: string[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const mb = g[0].promo!.multiBuy!;
    const separate = g.reduce((n, d) => n + ballsPrice(d.dozens, d.pricePerDozenPence, mb).total, 0);
    const together = ballsPrice(
      g.reduce((n, d) => n + d.dozens, 0),
      g[0].pricePerDozenPence,
      mb,
    ).total;
    if (together < separate) {
      saving += separate - together;
      titles.push(g[0].promo!.title);
    }
  }
  return { saving, titles };
}

/** Picks the right variant for a ball: a yellow ball needs a yellow variant; otherwise the non-yellow one. */
export function pickVariant(ballName: string, candidates: ShopifyVariant[]): ShopifyVariant | null {
  const handle = handleFor(ballName);
  const mine = candidates.filter((v) => v.handle === handle);
  if (!mine.length) return null;
  if (mine.length === 1) return mine[0];
  const yellow = /yellow/i.test(ballName);
  return mine.find((v) => /yellow/i.test(v.title) === yellow) ?? null;
}

export function buildDraftOrder(opts: {
  invoiceId: string;
  customer: InvoiceCustomer;
  designs: InvoiceDesign[];
  variants: ShopifyVariant[];
  /** Shopify customer id (gid), when known. */
  shopifyCustomerId?: string | null;
}): InvoicePlan {
  const { invoiceId, customer, designs, variants } = opts;
  if (!designs.length) throw new Error('No designs to invoice.');
  const warnings: string[] = [];
  const lineItems: DraftLineItem[] = [];
  const lines: InvoiceLine[] = [];
  const refs = designs.map((d) => d.quoteNumber).join(', ');

  for (const d of designs) {
    const ballLabel = `${d.ball.brand} ${d.ball.name}`;
    const v = pickVariant(d.ball.name, variants);
    const attrs: Attr[] = [{ key: 'COS quote', value: d.quoteNumber }];
    if (v && v.pricePence === d.pricePerDozenPence) {
      lineItems.push({ variantId: v.variantId, quantity: d.dozens, customAttributes: attrs });
      lines.push({ label: `${ballLabel} (dozen)`, quantity: d.dozens, unitPence: v.pricePence, shopifyProduct: true });
    } else {
      const why = v
        ? `${ballLabel}: Shopify price ${fmt(v.pricePence)} doesn’t match the COS price ${fmt(d.pricePerDozenPence)}, so it’s invoiced as a custom line at the COS price (Shopify stock won’t go down).`
        : `${ballLabel}: no Shopify product with handle “${handleFor(d.ball.name)}”, so it’s invoiced as a custom line at the COS price (Shopify stock won’t go down).`;
      warnings.push(why);
      lineItems.push({
        title: `${ballLabel} (dozen)`, quantity: d.dozens, originalUnitPriceWithCurrency: gbp(d.pricePerDozenPence), requiresShipping: true, taxable: true, customAttributes: attrs,
      });
      lines.push({ label: `${ballLabel} (dozen)`, quantity: d.dozens, unitPence: d.pricePerDozenPence, shopifyProduct: false, note: 'Custom line: no matching Shopify product' });
    }

    const personalAttrs: Attr[] = [
      { key: 'COS quote', value: d.quoteNumber },
      { key: 'Ball', value: `${d.dozens} dozen ${ballLabel}` },
      { key: 'Personalisation', value: d.personalisation.slice(0, 250) },
      ...(d.proofUrl ? [{ key: 'Proof image', value: d.proofUrl }] : []),
      ...(d.logoUrl ? [{ key: 'Logo image', value: d.logoUrl }] : []),
    ];
    const what = d.personalisation.replace(/^(Text|Logo): /, '');
    const title = `${d.setupFeePence ? 'Personalisation' : 'Free personalisation'}: ${what} – ${d.reference ?? d.quoteNumber}`.slice(0, 255);
    lineItems.push({ title, quantity: 1, originalUnitPriceWithCurrency: gbp(d.setupFeePence), requiresShipping: false, taxable: true, customAttributes: personalAttrs });
    lines.push({ label: title, quantity: 1, unitPence: d.setupFeePence, shopifyProduct: false });
  }

  const subtotal = lines.reduce((n, l) => n + l.quantity * l.unitPence, 0);
  const cosTotal = designs.reduce((n, d) => n + d.quoteTotalPence, 0);
  const { saving, titles } = combinedSaving(designs);
  const target = cosTotal - saving;
  let discount = subtotal - target;
  const priced = designs.reduce((n, d) => n + designPrice(d), 0);

  // The quote total was raised by staff above the ball + setup price: add the difference as a line.
  if (discount < 0) {
    const extra = -discount;
    lineItems.push({ title: 'Price adjustment (agreed on COS quote)', quantity: 1, originalUnitPriceWithCurrency: gbp(extra), requiresShipping: false, taxable: true, customAttributes: [{ key: 'COS quote', value: refs }] });
    lines.push({ label: 'Price adjustment (agreed on COS quote)', quantity: 1, unitPence: extra, shopifyProduct: false });
    warnings.push(`The quote total is ${fmt(extra)} more than the balls and setup add up to, so a price adjustment line is added.`);
    discount = 0;
  }
  const subtotalPence = lines.reduce((n, l) => n + l.quantity * l.unitPence, 0);
  if (priced !== cosTotal && discount >= 0 && cosTotal < priced) {
    warnings.push(`The quote total (${fmt(cosTotal)}) was changed from the calculated price (${fmt(priced)}); the invoice uses the quote total.`);
  }
  if (saving) warnings.push(`Multi-buy applied across these designs together: ${fmt(saving)} less than invoicing them one by one.`);

  const multi = designs.find((d) => d.promo?.multiBuy)?.promo;
  const discountTitle =
    multi?.multiBuy && (saving || designs.some((d) => ballsPrice(d.dozens, d.pricePerDozenPence, d.promo?.multiBuy).groups))
      ? `${multi.title}: ${multi.multiBuy.dozens} dozen for ${fmt(multi.multiBuy.pricePence)}`
      : 'Price agreed on your COS quote';

  const phone = e164(customer.phone);

  const designNotes = designs.map((d) =>
    [
      `${d.quoteNumber}: ${d.dozens} dozen ${d.ball.brand} ${d.ball.name}`,
      `  ${d.personalisation}`,
      ...(d.proofUrl ? [`  Proof: ${d.proofUrl}`] : []),
      ...(d.logoUrl ? [`  Logo: ${d.logoUrl}`] : []),
    ].join('\n'),
  );
  const note = [
    `PRINT BEFORE POSTING – COS ${designs.map((d) => d.reference ?? d.quoteNumber).join(', ')}. Personalised golf balls: hold this order until the balls are printed.`,
    ...designs.filter((d) => d.cosUrl).map((d) => `COS: ${d.cosUrl}`),
    `Pay before print: the proof has been approved; printing starts once this is paid.`,
    `Customer: ${customer.name}${customer.phone ? `, ${customer.phone}` : ''}`,
    ...(titles.length || multi ? [`Promotion: ${(multi?.title ?? titles[0])}`] : []),
    '',
    ...designNotes,
  ]
    .join('\n')
    .slice(0, 4900);

  const input: DraftOrderInput = {
    email: customer.email,
    ...(phone ? { phone } : {}),
    note,
    tags: [PRINT_TAG, 'COS', 'Pay before print', ...(multi ? [multi.title.slice(0, 40)] : [])],
    customAttributes: [
      { key: COS_INVOICE_ATTR, value: invoiceId },
      { key: 'COS quotes', value: refs },
      { key: 'Customer name', value: customer.name },
    ],
    lineItems,
    ...(discount > 0
      ? { appliedDiscount: { title: discountTitle.slice(0, 255), description: `COS ${refs}`.slice(0, 255), value: Number(pounds(discount)), valueType: 'FIXED_AMOUNT' as const } }
      : {}),
    ...(customer.address ? { shippingAddress: { ...splitName(customer.name), ...customer.address, ...(phone ? { phone } : {}) } } : {}),
    ...(opts.shopifyCustomerId ? { purchasingEntity: { customerId: opts.shopifyCustomerId } } : {}),
    acceptAutomaticDiscounts: false,
  };
  return { input, lines, subtotalPence, discountPence: discount, totalPence: subtotalPence - discount, cosTotalPence: cosTotal, warnings };
}

/** The bits of a paid Shopify order (REST webhook) that say how it reaches the customer. */
export type OrderShipping = { shipping_lines?: { title?: string | null; code?: string | null; source?: string | null }[] | null; shipping_address?: unknown };

/**
 * Delivery or collection, from the paid order. Pickup shows as a shipping line whose title/code/source
 * mentions pick up / collect (Shopify's local pickup, or our own "Collect from…" line). Any other
 * shipping line is a delivery. No line and no address: treated as collection.
 */
export function deliveryFromOrder(o: OrderShipping): { method: 'delivery' | 'collection' | 'unknown'; label: string } {
  const line = o.shipping_lines?.[0];
  if (line) {
    const text = `${line.title ?? ''} ${line.code ?? ''} ${line.source ?? ''}`;
    if (/pick ?-?up|collect/i.test(text)) return { method: 'collection', label: line.title || 'Collection' };
    return { method: 'delivery', label: line.title || 'Delivery' };
  }
  if (o.shipping_address) return { method: 'delivery', label: 'Delivery' };
  return { method: 'unknown', label: 'No delivery method on the Shopify order' };
}

/**
 * Pay before print applies to ball designs customers send online (the design page or a promotion),
 * for the shop linked to Shopify, once invoices are live (SHOPIFY_INVOICES=live). Approving those
 * sends a Shopify invoice; print starts once paid. In test mode approvals work as before, so the
 * shop isn't stuck while Shopify is being set up (staff can still preview the invoice).
 */
export function payBeforePrint(org: { slug: string }, specificationJson: unknown) {
  if (process.env.SHOPIFY_INVOICES?.trim().toLowerCase() !== 'live') return false;
  const s = asBallPrintSpec(specificationJson);
  return Boolean(s && (s.submittedOnline || s.promo) && org.slug === (process.env.SHOPIFY_COS_ORG?.trim() || 'desirable-golf'));
}
