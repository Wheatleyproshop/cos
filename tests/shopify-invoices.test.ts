import { createHmac } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { orders, organisations, payments, quotes, shopifyInvoices, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import type { Ctx } from '@/lib/services/common';
import { buildDraftOrder, deliveryFromOrder, e164, handleFor, KNOWN_PROMO_VARIANTS, type InvoiceDesign } from '@/lib/shopify-invoice';

vi.mock('server-only', () => ({}));

/* ───────────────────────────── Pure payload (dry run) ───────────────────────────── */

const PROMO = { id: 'promo-1', title: 'Titleist No.1 Gift in Golf', multiBuy: { dozens: 2, pricePence: 8000 } };
let n = 0;
const design = (name: string, dozens: number, extra: Partial<InvoiceDesign> = {}): InvoiceDesign => {
  const total = Math.floor(dozens / 2) * 8000 + (dozens % 2) * 4500;
  n += 1;
  return {
    quoteId: `00000000-0000-0000-0000-00000000000${n}`, quoteNumber: `Q-${100 + n}`, ball: { brand: 'Titleist', name }, dozens, pricePerDozenPence: 4500, setupFeePence: 0,
    quoteTotalPence: total, personalisation: 'Text: “Happy Christmas Dad”', proofUrl: 'https://cos.example/proof', logoUrl: null, promo: PROMO, ...extra,
  };
};
const customer = { name: 'Gift Buyer', email: 'gift@example.com', phone: '07700 900123' };
const build = (designs: InvoiceDesign[]) => buildDraftOrder({ invoiceId: '11111111-2222-3333-4444-555555555555', customer, designs, variants: KNOWN_PROMO_VARIANTS });

describe('pay before print: the Shopify draft order', () => {
  it('maps balls to Shopify handles', () => {
    expect(['Pro V1', 'Pro V1x', 'Pro V1x Left Dash', 'Pro V1 Yellow'].map(handleFor)).toEqual(['pro-v1', 'pro-v1x', 'pro-v1x-left-dash', 'pro-v1-yellow']);
  });

  it('1 dozen = £45: the Shopify variant plus a free personalisation line, no discount', () => {
    const p = build([design('Pro V1', 1)]);
    expect(p.totalPence).toBe(4500);
    expect(p.cosTotalPence).toBe(4500);
    expect(p.discountPence).toBe(0);
    expect(p.input.appliedDiscount).toBeUndefined();
    expect(p.input.acceptAutomaticDiscounts).toBe(false);
    expect(p.input.lineItems[0]).toEqual({ variantId: 'gid://shopify/ProductVariant/54890192109948', quantity: 1, customAttributes: [{ key: 'COS quote', value: expect.stringMatching(/^Q-/) }] });
    const personal = p.input.lineItems[1] as { title: string; originalUnitPriceWithCurrency: { amount: string }; customAttributes: { key: string; value: string }[] };
    expect(personal.title).toBe(`Free personalisation: “Happy Christmas Dad” – ${p.input.lineItems[0].customAttributes[0].value}`);
    expect(personal.originalUnitPriceWithCurrency).toEqual({ amount: '0.00', currencyCode: 'GBP' });
    expect(personal.customAttributes.map((a) => a.key)).toEqual(['COS quote', 'Ball', 'Personalisation', 'Proof image']);
    expect(p.input.customAttributes[0]).toEqual({ key: 'COS invoice', value: '11111111-2222-3333-4444-555555555555' });
    expect(p.input.note).toContain('Happy Christmas Dad');
    expect(p.input.phone).toBe('+447700900123');
    expect(p.warnings).toEqual([]);
  });

  it('2 dozen of one ball = £80', () => {
    const p = build([design('Pro V1x', 2)]);
    expect(p.subtotalPence).toBe(9000);
    expect(p.totalPence).toBe(8000);
    expect(p.input.appliedDiscount).toMatchObject({ value: 10, valueType: 'FIXED_AMOUNT', title: 'Titleist No.1 Gift in Golf: 2 dozen for £80.00' });
  });

  it('2 dozen of mixed promo balls (two designs on one invoice) = £80, even though each design alone was £45', () => {
    const p = build([design('Pro V1', 1), design('Pro V1x Left Dash', 1)]);
    expect(p.cosTotalPence).toBe(9000);
    expect(p.totalPence).toBe(8000);
    expect(p.input.appliedDiscount!.value).toBe(10);
    expect(p.input.lineItems.filter((l) => 'variantId' in l).map((l) => (l as { variantId: string }).variantId)).toEqual([
      'gid://shopify/ProductVariant/54890192109948',
      'gid://shopify/ProductVariant/54906911981948',
    ]);
    expect(p.warnings.join(' ')).toMatch(/Multi-buy applied across these designs/);
  });

  it('3 dozen follows the COS price (£80 + £45 = £125), not Shopify’s “£5 off each”', () => {
    expect(build([design('Pro V1', 3)]).totalPence).toBe(12500);
    expect(build([design('Pro V1', 2), design('Pro V1x', 2)]).totalPence).toBe(16000);
  });

  it('a ball with no Shopify product (Pro V1 Yellow) becomes a custom line at the COS price, flagged', () => {
    const p = build([design('Pro V1 Yellow', 1)]);
    const line = p.input.lineItems[0] as { title: string; originalUnitPriceWithCurrency: { amount: string } };
    expect(line.title).toBe('Titleist Pro V1 Yellow (dozen)');
    expect(line.originalUnitPriceWithCurrency.amount).toBe('45.00');
    expect(p.totalPence).toBe(4500);
    expect(p.warnings[0]).toMatch(/no Shopify product with handle “pro-v1-yellow”/);
  });

  it('a Shopify price that differs from COS falls back to a custom line, so the total still matches', () => {
    const variants = KNOWN_PROMO_VARIANTS.map((v) => ({ ...v, pricePence: 5000 }));
    const p = buildDraftOrder({ invoiceId: 'x', customer, designs: [design('Pro V1', 1)], variants });
    expect('variantId' in p.input.lineItems[0]).toBe(false);
    expect(p.totalPence).toBe(4500);
    expect(p.warnings[0]).toMatch(/doesn’t match the COS price/);
  });

  it('respects a staff-edited quote total (lower = discount, higher = adjustment line)', () => {
    expect(build([design('Pro V1', 1, { quoteTotalPence: 4000 })]).totalPence).toBe(4000);
    const up = build([design('Pro V1', 1, { quoteTotalPence: 5000 })]);
    expect(up.totalPence).toBe(5000);
    expect(up.input.appliedDiscount).toBeUndefined();
  });

  it('tags personalised orders and says print before posting, so Click & Drop orders can be held back', () => {
    const p = build([design('Pro V1', 1)]);
    expect(p.input.tags).toContain('personalised-print');
    expect(p.input.note.split('\n')[0]).toMatch(/^PRINT BEFORE POSTING – COS Q-\d+/);
  });

  it('leaves postage to the checkout (no shipping line): Royal Mail or click & collect is the customer’s choice', () => {
    expect((build([design('Pro V1', 1)]).input as Record<string, unknown>).shippingLine).toBeUndefined();
  });

  it('passes the customer through: Shopify customer id, and an address when COS has one', () => {
    const p = buildDraftOrder({
      invoiceId: 'x', customer: { ...customer, address: { address1: '1 High St', city: 'Doncaster', zip: 'DN2 5LD', countryCode: 'GB' } },
      designs: [design('Pro V1', 1)], variants: KNOWN_PROMO_VARIANTS, shopifyCustomerId: 'gid://shopify/Customer/7',
    });
    expect(p.input.purchasingEntity).toEqual({ customerId: 'gid://shopify/Customer/7' });
    expect(p.input.shippingAddress).toEqual({ firstName: 'Gift', lastName: 'Buyer', address1: '1 High St', city: 'Doncaster', zip: 'DN2 5LD', countryCode: 'GB', phone: '+447700900123' });
    expect(build([design('Pro V1', 1)]).input.shippingAddress).toBeUndefined();
  });

  it('reads delivery or collection off the paid order', () => {
    expect(deliveryFromOrder({ shipping_lines: [{ title: 'UK Free shipping', code: 'UK Free shipping', source: 'shopify' }] })).toEqual({ method: 'delivery', label: 'UK Free shipping' });
    expect(deliveryFromOrder({ shipping_lines: [{ title: 'Wheatley Golf Club', code: 'Pickup', source: 'shopify' }] }).method).toBe('collection');
    expect(deliveryFromOrder({ shipping_lines: [{ title: 'Click & collect - Wheatley Golf Club pro shop, Doncaster (free)', code: 'Click & collect', source: 'shopify' }] }).method).toBe('collection');
    expect(deliveryFromOrder({ shipping_lines: [{ title: 'Royal Mail Tracked 48', code: 'Tracked 48', source: 'shopify' }] }).method).toBe('delivery');
    expect(deliveryFromOrder({ shipping_lines: [] }).method).toBe('unknown');
  });

  it('only sends phone numbers Shopify accepts', () => {
    expect(e164('07700 900123')).toBe('+447700900123');
    expect(e164('+44 1302 123456')).toBe('+441302123456');
    expect(e164('ext 12')).toBeNull();
  });
});

/* ───────────────────────── Whole flow (fake Shopify, no network) ───────────────────────── */

let close: () => Promise<void>;
let org: Organisation;
let manager: Ctx;
const proof = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])], 'proof.jpg', { type: 'image/jpeg' });
const SECRET = 'test-webhook-secret';

beforeAll(async () => {
  const h = await runMigrations('pglite:memory://', { keepOpen: true });
  setDatabaseHandle(h);
  close = h.close;
  await seedDemo(h.db);
  const db = systemDb();
  [org] = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  const [aaron] = await db.select().from(users).where(eq(users.email, 'aaron@desirablegolf.test'));
  manager = { org, actor: staffActor(aaron), userId: aaron.id, role: 'admin' };
  const { getBallRange, addStarterBalls, addBall } = await import('@/lib/services/ball-printing');
  if (!(await getBallRange(org.id)).length) await addStarterBalls(manager);
  await addBall(manager, { brand: 'Titleist', name: 'Pro V1x Left Dash', colour: '#ffffff', pricePerDozenPence: '50.00', minDozens: '1', leadTimeDays: '14' });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await close();
});

async function promoWithTwoDesigns(email: string) {
  const promos = await import('@/lib/services/ball-promotions');
  const { getBallRange } = await import('@/lib/services/ball-printing');
  const range = await getBallRange(org.id);
  const id = (name: string) => range.find((b) => b.brand === 'Titleist' && b.name === name)!.id;
  const form: Record<string, string> = { title: 'Titleist No.1 Gift in Golf', setupFee: '0', minDozens: '1', multiBuyDozens: '2', multiBuyPrice: '80' };
  for (const b of ['Pro V1', 'Pro V1x', 'Pro V1x Left Dash', 'Pro V1 Yellow']) Object.assign(form, { [`ball_${id(b)}`]: 'yes', [`price_${id(b)}`]: '45' });
  const p = await promos.createBallPromotion(manager, form);
  const send = (ball: string, ip: string) =>
    promos.submitPromotionDesign(
      p.token,
      { customerName: 'Gift Buyer', email, phone: '07700 900123', ballId: id(ball), artworkType: 'text', textLines: ['Happy Christmas Dad'], font: 'classic', ink: 'navy', scale: '0.8', dozens: '1', notes: '' },
      { logo: null, proof: proof() },
      { ip },
    );
  return [await send('Pro V1', '203.0.113.31'), await send('Pro V1x Left Dash', '203.0.113.32')];
}

describe('pay before print: approve, invoice, paid', () => {
  it('test mode (default) works out £80 for the two designs and sends nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = await import('@/lib/services/shopify-invoices');
    const [a, b] = await promoWithTwoDesigns('dry@example.com');
    expect([a.totalGrossPence, b.totalGrossPence]).toEqual([4500, 4500]);
    const r = await svc.approveAndSendInvoice(manager, a.id, [b.id]);
    expect(r.mode).toBe('dry_run');
    expect(r.invoice.status).toBe('dry_run');
    expect(r.plan.totalPence).toBe(8000);
    expect(r.plan.cosTotalPence).toBe(9000);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A test invoice doesn't hold the designs: they can still be invoiced for real.
    expect((await svc.payStatesForQuotes(org.id, [a.id])).size).toBe(0);
    expect((await svc.invoiceCompanions(org.id, a)).map((c) => c.id)).toContain(b.id);
    vi.unstubAllGlobals();
  });

  it('live: creates the draft order, has Shopify email it, then the signed paid webhook puts both designs into print', async () => {
    vi.stubEnv('SHOPIFY_INVOICES', 'live');
    vi.stubEnv('SHOPIFY_STORE_DOMAIN', 'desirable-golf-online-store.myshopify.com');
    vi.stubEnv('SHOPIFY_ADMIN_TOKEN', 'shpat_fake_for_tests');
    vi.stubEnv('SHOPIFY_WEBHOOK_SECRET', SECRET);
    const sent: { query: string; variables: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
      expect(url).toBe('https://desirable-golf-online-store.myshopify.com/admin/api/2026-10/graphql.json');
      const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      sent.push(body);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (body.query.includes('products(')) {
        return json({
          products: {
            nodes: [
              { handle: 'pro-v1', title: 'Titleist Pro V1', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/54890192109948', title: 'Default Title', price: '45.00', compareAtPrice: '50.00' }] } },
              { handle: 'pro-v1x-left-dash', title: 'Titleist Pro V1x Left Dash', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/54906911981948', title: 'Default Title', price: '45.00', compareAtPrice: '50.00' }] } },
            ],
          },
        });
      }
      if (body.query.includes('customers(')) return json({ customers: { nodes: [] } });
      if (body.query.includes('customerCreate')) {
        expect(body.variables.input).toEqual({ firstName: 'Gift', lastName: 'Buyer', email: 'live@example.com', phone: '+447700900123' });
        return json({ customerCreate: { customer: { id: 'gid://shopify/Customer/77' }, userErrors: [] } });
      }
      if (body.query.includes('draftOrderCreate')) {
        return json({ draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/999', name: '#D42', invoiceUrl: 'https://shop.example/invoice/abc', status: 'OPEN', totalPriceSet: { shopMoney: { amount: '80.00' } } }, userErrors: [] } });
      }
      if (body.query.includes('draftOrderInvoiceSend')) return json({ draftOrderInvoiceSend: { draftOrder: { id: 'gid://shopify/DraftOrder/999', invoiceSentAt: new Date().toISOString() }, userErrors: [] } });
      throw new Error(`unexpected Shopify call: ${body.query}`);
    });

    const svc = await import('@/lib/services/shopify-invoices');
    const [a, b] = await promoWithTwoDesigns('live@example.com');
    const r = await svc.approveAndSendInvoice(manager, a.id, [b.id]);
    expect(r.mode).toBe('live');
    expect(r.invoice).toMatchObject({ status: 'awaiting_payment', draftOrderId: 'gid://shopify/DraftOrder/999', draftOrderName: '#D42', invoiceUrl: 'https://shop.example/invoice/abc', totalPence: 8000 });
    const create = sent.find((s) => s.query.includes('draftOrderCreate'))!.variables.input as { appliedDiscount: { value: number }; acceptAutomaticDiscounts: boolean; purchasingEntity: unknown; tags: string[] };
    expect(create.purchasingEntity).toEqual({ customerId: 'gid://shopify/Customer/77' });
    expect(create.tags).toContain('personalised-print');
    expect(create.appliedDiscount.value).toBe(10);
    expect(create.acceptAutomaticDiscounts).toBe(false);
    expect(sent.some((s) => s.query.includes('draftOrderInvoiceSend'))).toBe(true);

    const states = await svc.payStatesForQuotes(org.id, [a.id, b.id]);
    expect(states.get(a.id)).toMatchObject({ label: 'Awaiting payment', overdue: false });
    await expect(svc.approveAndSendInvoice(manager, b.id)).rejects.toThrow(/already has a Shopify invoice/);
    // Over three days unpaid is flagged.
    expect(svc.payStateOf({ ...r.invoice, sentAt: new Date(Date.now() - 4 * 86_400_000) }).overdue).toBe(true);

    // Shopify → COS webhook.
    const { POST } = await import('@/app/api/webhooks/shopify/route');
    const order = { id: 5551234, admin_graphql_api_id: 'gid://shopify/Order/5551234', name: '#1234', financial_status: 'paid', total_price: '80.00', note_attributes: [{ name: 'COS invoice', value: r.invoice.id }], shipping_lines: [{ title: 'UK Free shipping', code: 'UK Free shipping', source: 'shopify' }] };
    const raw = JSON.stringify(order);
    const call = (sig: string) =>
      POST(new Request('http://localhost/api/webhooks/shopify', {
        method: 'POST', body: raw,
        headers: { 'x-shopify-hmac-sha256': sig, 'x-shopify-topic': 'orders/paid', 'x-shopify-shop-domain': 'desirable-golf-online-store.myshopify.com' },
      }));
    expect((await call('bad-signature')).status).toBe(401);
    const good = createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true, already: false });

    const [inv] = await withTenant(org.id, (tx) => tx.select().from(shopifyInvoices).where(eq(shopifyInvoices.id, r.invoice.id)));
    expect(inv).toMatchObject({ status: 'paid', shopifyOrderName: '#1234', deliveryMethod: 'delivery', deliveryLabel: 'UK Free shipping' });
    const qs = await withTenant(org.id, (tx) => tx.select().from(quotes).where(inArray(quotes.id, [a.id, b.id])));
    expect(qs.map((q) => q.status)).toEqual(['accepted', 'accepted']);
    const os = await withTenant(org.id, (tx) => tx.select().from(orders).where(inArray(orders.quoteId, [a.id, b.id])));
    expect(os).toHaveLength(2);
    expect(os[0].internalNotes).toContain('Paid on Shopify #1234 · Post: UK Free shipping · Print before posting.');
    const ps = await withTenant(org.id, (tx) => tx.select().from(payments).where(inArray(payments.orderId, os.map((o) => o.id))));
    expect(ps.reduce((n, p) => n + p.amountPence, 0)).toBe(8000);
    expect(ps.every((p) => p.reference === 'Shopify #1234' && p.method === 'card')).toBe(true);
    expect((await svc.payStatesForQuotes(org.id, [a.id])).get(a.id)!.label).toBe('Paid – ready to print');

    // Shopify retries: nothing happens twice.
    expect(await (await call(good)).json()).toMatchObject({ matched: true, already: true });
    const again = await withTenant(org.id, (tx) => tx.select().from(payments).where(inArray(payments.orderId, os.map((o) => o.id))));
    expect(again).toHaveLength(ps.length);
  });
});

describe('pay before print: approving never starts print unpaid', () => {
  it('staff can’t approve an online ball design into print without payment; “Mark paid in store” records it', async () => {
    const quotesSvc = await import('@/lib/services/quotes');
    const [a, b] = await promoWithTwoDesigns('till@example.com');
    await expect(quotesSvc.acceptQuoteInStore(manager, a.id, 'Gift Buyer')).rejects.toThrow(/paid before it’s printed/);
    await expect(quotesSvc.acceptQuoteForCustomer(manager, b.id)).rejects.toThrow(/paid before it’s printed/);
    const order = await quotesSvc.acceptQuoteInStore(manager, a.id, 'Gift Buyer', { paidInStore: { method: 'cash' } });
    const ps = await withTenant(org.id, (tx) => tx.select().from(payments).where(eq(payments.orderId, order.id)));
    expect(ps).toMatchObject([{ amountPence: 4500, method: 'cash', reference: 'Paid in store (no Shopify invoice)' }]);
  });

  it('the customer approving on their emailed link creates the invoice instead of an order', async () => {
    vi.stubEnv('SHOPIFY_INVOICES', '');
    const quotesSvc = await import('@/lib/services/quotes');
    const svc = await import('@/lib/services/shopify-invoices');
    const [a] = await promoWithTwoDesigns('link@example.com');
    const url = await quotesSvc.createApprovalLink(manager, a.id);
    const token = url.split('/q/')[1];
    await expect(quotesSvc.acceptQuoteByToken(token, 'Gift Buyer', {})).rejects.toThrow(/payment link/);
    const found = (await quotesSvc.findQuoteByToken(token))!;
    const r = await svc.approveByCustomerAndInvoice(found, 'Gift Buyer');
    expect(r.mode).toBe('dry_run');
    const [q] = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, a.id)));
    expect(q.status).toBe('sent');
    expect(q.convertedOrderId).toBeNull();
    expect((await svc.latestInvoiceForQuote(org.id, a.id))!.status).toBe('dry_run');
  });

  it('an order approved before pay-before-print (like COS-1043) can be sent a Shopify invoice for what’s owed', async () => {
    vi.stubEnv('SHOPIFY_INVOICES', '');
    const quotesSvc = await import('@/lib/services/quotes');
    const svc = await import('@/lib/services/shopify-invoices');
    const [a] = await promoWithTwoDesigns('legacy@example.com');
    // Simulate the old in-store approval (straight into print, nothing paid).
    const ctx = { ...manager, org: { ...org, slug: 'some-other-shop' } };
    const order = await quotesSvc.acceptQuoteInStore(ctx, a.id, 'Gift Buyer');
    const r = await svc.sendInvoiceForOrder(manager, order.id);
    expect(r.plan.totalPence).toBe(4500);
    expect(r.plan.input.note).toContain(`PRINT BEFORE POSTING – COS ${order.orderNumber}`);
    expect(r.plan.input.note).toContain(`/orders/${order.orderNumber}`);
    const personal = r.plan.input.lineItems[1] as { title: string };
    expect(personal.title).toBe(`Free personalisation: “Happy Christmas Dad” (Classic serif, Navy ink) – ${order.orderNumber}`);
  });
});
