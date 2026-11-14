import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { messages, orders, organisations, quotes, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import type { Ctx } from '@/lib/services/common';
import { createOrder, updateOrderProgress } from '@/lib/services/orders';
import { readyText, smsSafe, ukMobile } from '@/lib/sms';

let close: () => Promise<void>;
let org: Organisation;
let staff: Ctx;
let manager: Ctx;

async function reloadOrg() {
  [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  staff = { ...staff, org };
  manager = { ...manager, org };
}

beforeAll(async () => {
  const h = await runMigrations('pglite:memory://', { keepOpen: true });
  setDatabaseHandle(h);
  close = h.close;
  await seedDemo(h.db);
  const db = systemDb();
  [org] = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  const [will] = await db.select().from(users).where(eq(users.email, 'will@desirablegolf.test'));
  staff = { org, actor: staffActor(will), userId: will.id, role: 'staff' };
  const [aaron] = await db.select().from(users).where(eq(users.email, 'aaron@desirablegolf.test'));
  manager = { org, actor: staffActor(aaron), userId: aaron.id, role: 'admin' };
});

afterAll(async () => close?.());

const order = (o: Record<string, string>) =>
  createOrder(staff, { customerName: 'Sheet Test', email: `sheet-${Math.random().toString(36).slice(2)}@example.com`, totalGrossPence: '100', depositMethod: 'card', ...o });

describe('text messages', () => {
  it('only texts UK mobiles, in plain characters', () => {
    expect(ukMobile('07700 900123')).toBe('+447700900123');
    expect(ukMobile('+44 (0)7700 900123')).toBe('+447700900123');
    expect(ukMobile('0044 7700 900123')).toBe('+447700900123');
    expect(ukMobile('01865 123456')).toBeNull();
    expect(ukMobile('')).toBeNull();
    expect(smsSafe('We’re “ready” – now…')).toBe('We\'re "ready" - now...');
    const t = readyText({ storeName: 'Desirable Golf', customerName: 'Ryan Cooper', reference: 'COS-1', what: 'Pro 245 Irons', balancePence: 5000 });
    expect(t).toBe('Desirable Golf: Hi Ryan, your Pro 245 Irons (COS-1) is ready to collect. Balance to pay: £50.00. See you soon!');
  });

  it('texts the customer with the ready email only when switched on', async () => {
    const off = await order({ phone: '07700 900111', brand: 'PING', product: 'G440 Driver' });
    await updateOrderProgress(staff, off.id, { status: 'ready', etaDate: '', supplierReference: '' });
    const offMsgs = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, off.id)));
    expect(offMsgs.some((m) => m.channel === 'sms')).toBe(false);

    await systemDb().update(organisations).set({ smsReady: true }).where(eq(organisations.id, org.id));
    await reloadOrg();
    const on = await order({ phone: '07700 900222', brand: 'PING', product: 'G440 Driver' });
    await updateOrderProgress(staff, on.id, { status: 'ready', etaDate: '', supplierReference: '' });
    const msgs = await withTenant(org.id, (tx) => tx.select().from(messages).where(and(eq(messages.orderId, on.id), eq(messages.channel, 'sms'))));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].recipient).toBe('+447700900222');
    expect(msgs[0].templateType).toBe('ready_for_collection');
    expect(msgs[0].status).toBe('sent');
    expect(msgs[0].simulated).toBe(true); // no Twilio account in tests
    expect(msgs[0].bodyText).toContain('is ready to collect');

    // No mobile on the record: email only.
    const landline = await order({ phone: '01865 123456', brand: 'PING', product: 'G440 Driver' });
    await updateOrderProgress(staff, landline.id, { status: 'ready', etaDate: '', supplierReference: '' });
    const none = await withTenant(org.id, (tx) => tx.select().from(messages).where(and(eq(messages.orderId, landline.id), eq(messages.channel, 'sms'))));
    expect(none).toHaveLength(0);

    // "Don't email the customer" (managers only) skips the text too.
    const quiet = await order({ phone: '07700 900333', brand: 'PING', product: 'G440 Driver' });
    await updateOrderProgress(manager, quiet.id, { status: 'ready', etaDate: '', supplierReference: '', notify: false });
    const q = await withTenant(org.id, (tx) => tx.select().from(messages).where(and(eq(messages.orderId, quiet.id), eq(messages.channel, 'sms'))));
    expect(q.map((m) => m.status)).toEqual(['suppressed']);
  });
});

describe('supplier order sheets', () => {
  it('groups what is to order by supplier, items on multi-item orders by their own brand', async () => {
    const { supplierSheets, orderEmail } = await import('@/lib/services/supplier-sheets');
    const a = await order({ brand: 'Srixon', product: 'ZX7 Mk III Irons', variant: '4-PW', sku: 'SRX-ZX7' });
    const b = await order({ brand: 'srixon', product: 'Z-Star balls', quantity: '1' });
    const multi = await order({
      brand: 'Srixon', product: 'Q-Star Tour balls', unitPricePence: '40', quantity: '2',
      extraItems: JSON.stringify([{ brand: 'Cleveland', product: 'RTX 6 Wedge', size: '56°', quantity: 1, unitPricePence: '150' }]),
    });
    const sheets = await supplierSheets(org);
    const srixon = sheets.toOrder.find((g) => g.key === 'srixon')!;
    expect(srixon.lines.map((l) => l.orderNumber)).toEqual([a.orderNumber, b.orderNumber, multi.orderNumber]);
    expect(srixon.lines[2]).toMatchObject({ itemIndex: 0, quantity: 2 });
    const cleveland = sheets.toOrder.find((g) => g.key === 'cleveland')!;
    expect(cleveland.lines).toHaveLength(1);
    expect(cleveland.lines[0]).toMatchObject({ orderNumber: multi.orderNumber, itemIndex: 1, product: 'RTX 6 Wedge' });

    const mail = orderEmail(org, srixon, 'Will');
    expect(mail.subject).toBe(`Order from ${org.storeName} - 4 items`);
    expect(mail.body).toContain(`1. ZX7 Mk III Irons   (our ref ${a.orderNumber})`);
    expect(mail.body).toContain('Product code: SRX-ZX7');
    expect(mail.body).toContain(`3. Q-Star Tour balls x 2   (our ref ${multi.orderNumber})`);
    expect(mail.body).not.toContain('£');
  });

  it('marks a supplier as placed; a multi-item order moves on once every item is ordered', async () => {
    const { supplierSheets, markSupplierPlaced } = await import('@/lib/services/supplier-sheets');
    const r = await markSupplierPlaced(staff, org, 'srixon', { supplierReference: 'SRX-998', etaDate: '' });
    expect(r.lines).toBe(3);
    const after = await supplierSheets(org);
    expect(after.toOrder.find((g) => g.key === 'srixon')).toBeUndefined();
    const multiNumber = after.toOrder.find((g) => g.key === 'cleveland')!.lines[0].orderNumber;
    const [m1] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, multiNumber)));
    expect(m1.status).toBe('place_order'); // the wedge is still to order

    await markSupplierPlaced(staff, org, 'cleveland', { supplierReference: '', etaDate: '' });
    const [m2] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, multiNumber)));
    expect(m2.status).toBe('ordered');
    const placed = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.supplierReference, 'SRX-998')));
    expect(placed.length).toBe(2);
    expect(placed.every((o) => o.status === 'ordered')).toBe(true);
  });

  it('lists placed orders to chase when late or quiet', async () => {
    const { supplierSheets, chaseEmail } = await import('@/lib/services/supplier-sheets');
    const late = await order({ brand: 'Mizuno', product: 'JPX 925 Irons' });
    await updateOrderProgress(staff, late.id, { status: 'ordered', etaDate: '2020-01-01', supplierReference: 'MZ-1' });
    const fresh = await order({ brand: 'Mizuno', product: 'ST-Max Driver' });
    await updateOrderProgress(staff, fresh.id, { status: 'ordered', etaDate: '', supplierReference: 'MZ-2' });
    const sheets = await supplierSheets(org);
    const mizuno = sheets.toChase.find((g) => g.key === 'mizuno')!;
    expect(mizuno.lines.map((l) => l.orderNumber)).toEqual([late.orderNumber]); // the fresh one isn't quiet yet
    expect(mizuno.lines[0].overdue).toBe(true);
    expect(chaseEmail(org, mizuno, 'Will').body).toContain('Your ref: MZ-1');
  });
});

describe('supplier lead times', () => {
  it('measures from placed with the supplier to arrived, per supplier and per item', async () => {
    const { supplierLeadTimes } = await import('@/lib/services/supplier-sheets');
    const before = (await supplierLeadTimes(org)).get('cobra')?.measured ?? 0;
    const o = await order({ brand: 'Cobra', product: 'DS-Adapt Driver' });
    await updateOrderProgress(staff, o.id, { status: 'ordered', etaDate: '', supplierReference: 'CB-1' });
    await updateOrderProgress(staff, o.id, { status: 'ready', etaDate: '', supplierReference: 'CB-1' });
    const multi = await order({
      brand: 'Cobra', product: 'Glove', unitPricePence: '10', quantity: '1',
      extraItems: JSON.stringify([{ brand: 'Cobra', product: 'Headcover', quantity: 1, unitPricePence: '10' }]),
    });
    const { updateOrderItem } = await import('@/lib/services/orders');
    await updateOrderItem(staff, multi.id, 1, { status: 'ordered', etaDate: '', supplierReference: '' });
    await updateOrderItem(staff, multi.id, 1, { status: 'arrived', etaDate: '', supplierReference: '' });
    const cobra = (await supplierLeadTimes(org)).get('cobra')!;
    expect(cobra.measured).toBe(before + 2); // the order, and the one item that has arrived
    expect(cobra.medianDays).toBeGreaterThanOrEqual(0);
    // An order that was never placed with the supplier isn't measured.
    const skipped = await order({ brand: 'Cobra', product: 'Umbrella' });
    await updateOrderProgress(staff, skipped.id, { status: 'ready', etaDate: '', supplierReference: '' });
    expect((await supplierLeadTimes(org)).get('cobra')!.measured).toBe(before + 2);
  });
});

describe('website special order requests', () => {
  it('arrives as a draft quote with a confirmation email', async () => {
    const { submitOrderRequest } = await import('@/lib/services/order-requests');
    const q = await submitOrderRequest(
      'desirable-golf',
      {
        customerName: 'Web Customer', email: 'web@example.com', phone: '07700 900444', brand: 'Titleist', category: 'Clubs', product: 'GT3 Driver',
        hand: 'Left-handed', quantity: '1', details: '9°, Tensei 1K Black 65 X', budget: '£550', neededBy: 'Within a month',
      },
      { ip: '203.0.113.50' },
    );
    expect(q.status).toBe('draft');
    expect(q.totalGrossPence).toBe(0);
    expect(q.specificationText).toContain('Hand: Left-handed');
    expect(q.specificationText).toContain('Tensei 1K Black 65 X');
    expect(q.internalNotes).toContain('Budget: £550');
    expect((q.specificationJson as { kind: string }).kind).toBe('cos-request');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.templateType).toBe('order_request_received');
    expect(msg.subject).toContain(q.quoteNumber);
  });

  it('checks the form, limits repeat senders and respects the on/off switch', async () => {
    const { submitOrderRequest, REQUEST_LIMITS } = await import('@/lib/services/order-requests');
    await expect(submitOrderRequest('desirable-golf', { customerName: 'X', email: 'nope', brand: '', product: '' }, { ip: null })).rejects.toMatchObject({
      fieldErrors: { email: expect.any(String), brand: expect.any(String), product: expect.any(String) },
    });
    const ok = { customerName: 'Busy Bee', email: 'bee@example.com', brand: 'Ping', product: 'Glove' };
    for (let i = 1; i < REQUEST_LIMITS.perIpPerHour; i++) await submitOrderRequest('desirable-golf', ok, { ip: '203.0.113.50' });
    await expect(submitOrderRequest('desirable-golf', ok, { ip: '203.0.113.50' })).rejects.toThrow(/a lot of requests/);
    await systemDb().update(organisations).set({ orderRequestLink: false }).where(eq(organisations.id, org.id));
    await expect(submitOrderRequest('desirable-golf', ok, { ip: '203.0.113.77' })).rejects.toThrow(/can’t be sent online/);
    const drafts = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.status, 'draft')));
    expect(drafts.length).toBeGreaterThan(0);
  });
});
