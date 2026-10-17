import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { auditEvents, customers, messages, orders, organisations, payments, quotes, users, type Organisation } from '@/db/schema';
import { DEMO_QUOTE_TOKEN, seedDemo } from '@/db/seed';
import { orderAttention } from '@/lib/attention';
import { staffActor } from '@/lib/audit';
import { addDays, parseMoneyToPence } from '@/lib/format';
import type { Ctx } from '@/lib/services/common';
import { createOrder, recordPayment, updateOrderProgress } from '@/lib/services/orders';
import { acceptQuoteByToken, createQuote, findQuoteByToken } from '@/lib/services/quotes';
import { runDailyJobs } from '@/lib/services/jobs';

let close: () => Promise<void>;
let org: Organisation;
let other: Organisation;
let admin: Ctx;
let staff: Ctx;

beforeAll(async () => {
  const h = await runMigrations('pglite:memory://', { keepOpen: true });
  setDatabaseHandle(h);
  close = h.close;
  await seedDemo(h.db);
  const db = systemDb();
  [org] = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  [other] = await db.select().from(organisations).where(eq(organisations.slug, 'fairway-demo'));
  const [aaron] = await db.select().from(users).where(eq(users.email, 'aaron@desirablegolf.test'));
  const [will] = await db.select().from(users).where(eq(users.email, 'will@desirablegolf.test'));
  admin = { org, actor: staffActor(aaron), userId: aaron.id, role: 'admin' };
  staff = { org, actor: staffActor(will), userId: will.id, role: 'staff' };
});

afterAll(async () => close?.());

/** Drizzle wraps driver errors; the database's own message is on `cause`. */
async function dbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  throw new Error('Expected the database to reject this statement');
}

describe('helpers', () => {
  it('parses money to pence', () => {
    expect(parseMoneyToPence('529')).toBe(52900);
    expect(parseMoneyToPence('£1,199.5')).toBe(119950);
    expect(parseMoneyToPence('12.345')).toBeNull();
    expect(parseMoneyToPence('abc')).toBeNull();
  });

  it('flags orders needing attention', () => {
    const base = { status: 'ordered' as const, readyAt: null, createdAt: new Date(), supplierReference: 'X', archivedAt: null };
    const t = { readyUncollectedDays: 7, quoteFollowupDays: 5, missingSupplierRefDays: 2 };
    expect(orderAttention({ ...base, etaDate: '2026-10-01' }, t, '2026-10-16').map((f) => f.code)).toEqual(['eta_passed']);
    expect(orderAttention({ ...base, etaDate: '2026-10-30' }, t, '2026-10-16')).toEqual([]);
    const old = new Date(Date.now() - 5 * 86_400_000);
    expect(orderAttention({ ...base, etaDate: null, supplierReference: '', createdAt: old }, t, '2026-10-16')[0].code).toBe('missing_supplier_ref');
  });
});

describe('tenant isolation (database-enforced)', () => {
  it('only returns rows for the scoped organisation, even without a WHERE clause', async () => {
    const mine = await withTenant(org.id, (tx) => tx.select({ n: orders.orderNumber }).from(orders));
    expect(mine.map((r) => r.n)).toContain('COS-1048');
    expect(mine.map((r) => r.n)).not.toContain('COS-2001');
    const theirs = await withTenant(other.id, (tx) => tx.select({ n: orders.orderNumber }).from(orders));
    expect(theirs.map((r) => r.n)).toEqual(['COS-2001']);
  });

  it('rejects writes into another organisation', async () => {
    const [anyCustomer] = await withTenant(org.id, (tx) => tx.select().from(orders).limit(1));
    await expect(
      withTenant(org.id, (tx) =>
        tx.insert(auditEvents).values({
          organisationId: other.id, entityType: 'order', actorType: 'system', actorLabel: 'x', eventType: 'note_added', orderId: anyCustomer.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('cannot read sessions or delete anything as the app role', async () => {
    await expect(withTenant(org.id, (tx) => tx.execute(sql`select * from sessions`))).rejects.toThrow();
    await expect(withTenant(org.id, (tx) => tx.delete(orders).where(eq(orders.orderNumber, 'COS-1048')))).rejects.toThrow();
  });
});

describe('audit integrity', () => {
  it('audit events and payments are append-only, even for the owner role', async () => {
    expect(await dbError(systemDb().update(auditEvents).set({ actorLabel: 'tampered' }))).toMatch(/append-only/);
    expect(await dbError(systemDb().delete(payments))).toMatch(/append-only/);
  });

  it('order taken-by and created-at cannot be changed', async () => {
    expect(
      await dbError(systemDb().update(orders).set({ takenByUserId: staff.userId! }).where(eq(orders.orderNumber, 'COS-1048'))),
    ).toMatch(/immutable/);
  });
});

describe('order lifecycle', () => {
  it('creates an order with deposit, ledger events and a confirmation email', async () => {
    const order = await createOrder(staff, {
      customerName: 'New Customer', email: 'NEW@example.com', phone: '07700 900999', brand: 'PING', product: 'i530 Irons',
      sku: 'PING-I530', specificationText: '5–PW / Black dot / KBS Tour Lite R', totalGrossPence: '1099.00', depositPence: '200',
      depositMethod: 'card', etaDate: '', supplierReference: '', internalNotes: '',
    });
    expect(order.orderNumber).toBe('COS-1052');
    expect(order.takenByUserId).toBe(staff.userId);
    const events = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.orderId, order.id)));
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['order_created', 'payment_recorded', 'email_queued', 'email_sent']));
    expect(events.find((e) => e.eventType === 'order_created')!.actorLabel).toBe('Will Walker');
    expect(events.find((e) => e.eventType === 'email_sent')!.actorType).toBe('system');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(msg.status).toBe('sent');
    expect(msg.bodyHtml).toContain('alt="Desirable Golf"'); // retailer logo, not COS
    expect(msg.bodyHtml).not.toMatch(/\bCOS\b(?!-)/);
  });

  it('validates input with field errors', async () => {
    await expect(createOrder(staff, { customerName: '', email: 'nope' })).rejects.toMatchObject({
      fieldErrors: expect.objectContaining({ customerName: expect.any(String), email: expect.any(String) }),
    });
  });

  it('ETA change, ready and collection follow the workflow and automations', async () => {
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1048')));
    await updateOrderProgress(staff, o.id, {
      status: 'ordered', etaDate: addDays(o.etaDate!, 5), etaReason: 'Shaft back-ordered', supplierReference: o.supplierReference, notify: true,
    });
    await updateOrderProgress(staff, o.id, { status: 'ready', etaDate: addDays(o.etaDate!, 5), supplierReference: o.supplierReference, notify: true });
    await expect(
      updateOrderProgress(staff, o.id, { status: 'collected', etaDate: addDays(o.etaDate!, 5), supplierReference: o.supplierReference, notify: true }),
    ).rejects.toThrow(/balance outstanding/);
    await recordPayment(staff, o.id, { kind: 'payment', amountPence: '429.00', method: 'card', reference: '' });
    await updateOrderProgress(staff, o.id, { status: 'collected', etaDate: addDays(o.etaDate!, 5), supplierReference: o.supplierReference, notify: true });

    const msgs = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, o.id)));
    expect(msgs.map((m) => m.templateType)).toEqual(expect.arrayContaining(['eta_revised', 'ready_for_collection']));
    const types = (await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.orderId, o.id)))).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['eta_changed', 'order_ready', 'order_collected', 'payment_recorded']));
  });

  it('staff cannot record refunds or suppress customer emails', async () => {
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1046')));
    await expect(recordPayment(staff, o.id, { kind: 'refund', amountPence: '1', method: 'card' })).rejects.toThrow(/manager/);
    await updateOrderProgress(staff, o.id, { status: 'delayed', etaDate: addDays(o.etaDate!, 1), supplierReference: o.supplierReference, notify: false });
    const msgs = await withTenant(org.id, (tx) =>
      tx.select().from(messages).where(and(eq(messages.orderId, o.id), eq(messages.templateType, 'eta_revised'))),
    );
    expect(msgs.some((m) => m.status === 'sent')).toBe(true); // notify=false ignored for staff
  });

  it('blocks invalid transitions', async () => {
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1049')));
    await expect(updateOrderProgress(staff, o.id, { status: 'collected', etaDate: o.etaDate ?? '', supplierReference: '' })).rejects.toThrow(
      /cannot move/,
    );
  });
});

describe('quotes', () => {
  it('customer approval via token converts the quote into an order without re-keying', async () => {
    const found = await findQuoteByToken(DEMO_QUOTE_TOKEN);
    expect(found?.quote.quoteNumber).toBe('Q-1001');
    const { order, trackingUrl } = await acceptQuoteByToken(DEMO_QUOTE_TOKEN, 'Emily Clarke', { ip: '127.0.0.1' });
    expect(trackingUrl).toMatch(/\/t\/[\w-]{40,}$/);
    expect(order.specificationText).toBe(found!.quote.specificationText);
    expect(order.totalGrossPence).toBe(found!.quote.totalGrossPence);
    expect(order.takenByUserId).toBe(found!.quote.createdByUserId);
    const [q] = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, found!.quote.id)));
    expect(q.status).toBe('accepted');
    expect(q.convertedOrderId).toBe(order.id);
    expect(await findQuoteByToken(DEMO_QUOTE_TOKEN)).toBeNull(); // single use
    const accepted = (await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.quoteId, q.id)))).find(
      (e) => e.eventType === 'quote_accepted',
    )!;
    expect(accepted.actorType).toBe('customer');
    expect((accepted.newValueJson as { totalGrossPence: number }).totalGrossPence).toBe(119900);
  });

  it('creates and sends a quote with a fresh approval link', async () => {
    const q = await createQuote(
      admin,
      {
        customerName: 'Quote Person', email: 'quote@example.com', brand: 'Ping', product: 'Blueprint S', sku: '',
        specificationText: '4–PW', totalGrossPence: '1450', depositRequiredPence: '300', estimatedLeadTime: '3 weeks', validUntil: '',
      },
      { send: true },
    );
    const [row] = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, q.id)));
    expect(row.status).toBe('sent');
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scheduled jobs', () => {
  it('sends collection reminders once and runs the COS-hosted backup', async () => {
    const first = await runDailyJobs();
    expect(first['desirable-golf'].reminders).toBeGreaterThanOrEqual(1);
    expect(first['desirable-golf'].backup).toBe('ok');
    const second = await runDailyJobs();
    expect(second['desirable-golf'].reminders).toBe(0);
  });
});

describe('custom fitting', () => {
  it('prices a build from the catalogue and creates a quote with a structured spec', async () => {
    const { getCatalog, createFittingQuote } = await import('@/lib/services/fitting');
    const c = await getCatalog(org.id);
    const model = c.models.find((m) => m.name === 'G440 MAX Driver')!;
    const pick = (name: string) => c.components.find((x) => x.name === name)!.id;
    const q = await createFittingQuote(
      staff,
      {
        customerName: 'Fitting Customer', email: 'fit@example.com', phone: '', modelId: model.id,
        componentIds: [pick('Fujikura Ventus Blue 6S'), pick('Golf Pride Tour Velvet'), pick('Titleist Pro V1 (dozen)')],
        buildNotes: '10.5° / Stiff / 45.25"', validUntil: '',
      },
      { send: false },
    );
    expect(q.totalGrossPence).toBe(93100); // £529 + £350 + £0 + £52, as in the design mock-up
    expect(q.status).toBe('draft');
    expect(q.specificationText).toContain('Shaft: Fujikura Ventus Blue 6S');
    // Head, Shaft, Grip and Ball each on their own line.
    const build = (q.specificationJson as { builds: { lines: { label: string }[] }[] }).builds[0];
    expect(build.lines.map((l) => l.label)).toEqual(['Head', 'Shaft', 'Grip', 'Ball']);
  });

  it('rejects components that do not fit the chosen head', async () => {
    const { getCatalog, createFittingQuote } = await import('@/lib/services/fitting');
    const c = await getCatalog(org.id);
    const model = c.models.find((m) => m.name === 'G440 MAX Driver')!;
    const ironShaft = c.components.find((x) => x.name === 'KBS Tour Lite (stock)')!.id;
    await expect(
      createFittingQuote(staff, { customerName: 'X', email: 'x@example.com', modelId: model.id, componentIds: [ironShaft] }, { send: false }),
    ).rejects.toThrow(/isn’t available/);
  });
});

describe('notifications', () => {
  it('shows other staff members’ new orders and approvals, not your own actions', async () => {
    const { listNotifications } = await import('@/lib/services/notifications');
    const forAaron = await listNotifications(org.id, admin.userId!);
    expect(forAaron.items.some((n) => n.title === 'New order received' && n.body.includes('Will Walker'))).toBe(true);
    expect(forAaron.items.some((n) => n.title === 'Quote approved')).toBe(true);
    const forWill = await listNotifications(org.id, staff.userId!);
    expect(forWill.items.some((n) => n.body.includes('taken by Will Walker'))).toBe(false);
  });
});

describe('email sender', () => {
  it('uses the shop’s own address only once its domain is verified', async () => {
    const { fromHeader, senderAddress } = await import('@/lib/email/sender');
    const prev = process.env.EMAIL_FROM_DOMAIN;
    process.env.EMAIL_FROM_DOMAIN = 'mail.cosgolf.co.uk';
    const shop = { slug: 'desirable-golf', storeName: 'Desirable Golf', senderEmail: 'orders@desirablegolf.co.uk', senderVerifiedAt: null };
    expect(senderAddress(shop)).toBe('desirable-golf@mail.cosgolf.co.uk');
    expect(fromHeader({ ...shop, senderVerifiedAt: new Date() })).toBe('"Desirable Golf" <orders@desirablegolf.co.uk>');
    process.env.EMAIL_FROM_DOMAIN = prev;
  });
});

describe('account credit', () => {
  it('records till account credit separately and reduces the balance', async () => {
    const order = await createOrder(staff, {
      customerName: 'Credit Customer', email: 'credit@example.com', brand: 'Titleist', product: 'Pro V1', sku: '',
      specificationText: '2 dozen', totalGrossPence: '104.00', depositPence: '20.00', depositMethod: 'card',
      creditPence: '30.00', etaDate: '', supplierReference: '', internalNotes: '',
    });
    const rows = await withTenant(org.id, (tx) => tx.select().from(payments).where(eq(payments.orderId, order.id)));
    const credit = rows.find((p) => p.kind === 'credit')!;
    expect(credit.amountPence).toBe(3000);
    expect(credit.method).toBe('account');
    const { paymentTotals } = await import('@/lib/services/common');
    const t = await withTenant(org.id, (tx) => paymentTotals(tx, order.id));
    expect(t).toEqual({ paid: 2000, credit: 3000 });
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(msg.bodyHtml).toContain('Account credit applied');
    expect(msg.bodyHtml).toContain('£54.00'); // balance due
    expect(msg.bodyHtml).toContain('placed with the manufacturer');
  });

  it('rejects deposit plus credit above the total', async () => {
    await expect(
      createOrder(staff, {
        customerName: 'X', email: 'x2@example.com', brand: 'B', product: 'P', specificationText: 'S',
        totalGrossPence: '10.00', depositPence: '6.00', creditPence: '5.00', etaDate: '',
      }),
    ).rejects.toMatchObject({ fieldErrors: expect.objectContaining({ creditPence: expect.any(String) }) });
  });
});

describe('payments taken at the till', () => {
  it('lets an order be collected without recording payment when payment tracking is off', async () => {
    const tillCtx = { ...staff, org: { ...org, paymentTracking: false } };
    const order = await createOrder(tillCtx, {
      customerName: 'Till Customer', email: 'till@example.com', brand: 'PING', product: 'Glove', specificationText: 'ML',
      totalGrossPence: '20.00', etaDate: '',
    });
    await updateOrderProgress(tillCtx, order.id, { status: 'ready', etaDate: '', supplierReference: '' });
    await updateOrderProgress(tillCtx, order.id, { status: 'collected', etaDate: '', supplierReference: '' });
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, order.id)));
    expect(o.status).toBe('collected');
  });
});

describe('customer import & returning customers', () => {
  const csv = [
    'First Name,Surname,E-mail,Mobile,Notes,Loyalty points',
    'Sam,Hill,sam@example.com,07700 111222,"Left-handed, likes stiff shafts",120',
    'James,Wilson,JAMES@example.com,07700 900111,,10', // existing seed customer (case-insensitive)
    'No,Email,,07700 333444,,0',
    ',,,,,',
    'Sam,Hill,sam@example.com,07700 111222,dup,0',
    'Bad,Address,not-an-email,,,0',
  ].join('\n');

  it('reads common column names and previews without saving', async () => {
    const { importCustomers } = await import('@/lib/services/customer-import');
    const preview = await importCustomers(admin, csv, { dryRun: true });
    expect(preview.plan.columns).toMatchObject({ first: 'First Name', last: 'Surname', email: 'E-mail', phone: 'Mobile', notes: 'Notes' });
    expect(preview).toMatchObject({ created: 3, duplicatesInFile: 1 });
    const none = await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.email, 'sam@example.com')));
    expect(none).toHaveLength(0);
  });

  it('imports new customers and never overwrites existing details', async () => {
    const { importCustomers } = await import('@/lib/services/customer-import');
    const before = (await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.email, 'james@example.com'))))[0];
    const res = await importCustomers(admin, csv, { dryRun: false });
    expect(res.created).toBe(3);
    const sam = (await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.email, 'sam@example.com'))))[0];
    expect(sam).toMatchObject({ name: 'Sam Hill', phone: '07700 111222', notes: 'Left-handed, likes stiff shafts' });
    const after = (await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.email, 'james@example.com'))))[0];
    expect(after.name).toBe(before.name);
    const noEmail = (await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.phone, '07700 333444'))))[0];
    expect(noEmail.email).toBe('');
    // second run: nothing new
    const again = await importCustomers(admin, csv, { dryRun: true });
    expect(again.created).toBe(0);
  });

  it('links a new order to the picked returning customer and adds their missing email', async () => {
    const [noEmail] = await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.phone, '07700 333444')));
    const order = await createOrder(staff, {
      customerId: noEmail.id, customerName: noEmail.name, email: 'now-has-email@example.com', phone: noEmail.phone,
      brand: 'PING', product: 'Putter', specificationText: '34"', totalGrossPence: '200', etaDate: '',
    });
    expect(order.customerId).toBe(noEmail.id);
    const [updated] = await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.id, noEmail.id)));
    expect(updated.email).toBe('now-has-email@example.com');
  });
});

describe('golf ball printing', () => {
  // Smallest valid JPEG header / PNG header: enough for the type sniffing that guards uploads.
  const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])], 'proof.jpg', { type: 'image/jpeg' });

  it('creates a priced proof quote and emails it with the signed proof image', async () => {
    const { addStarterBalls, getBallRange, createBallPrintQuote } = await import('@/lib/services/ball-printing');
    await expect(addStarterBalls(staff)).rejects.toThrow(/manager/);
    await addStarterBalls(admin);
    const [ball] = await getBallRange(org.id);
    const q = await createBallPrintQuote(
      staff,
      {
        customerName: 'Pat Print', email: 'pat@example.com', phone: '', ballId: ball.id, artworkType: 'text',
        textLines: ['Club Day', '2026', ''], font: 'classic', ink: 'navy', scale: '0.8', dozens: '3',
        pricePerDozenPence: '50.00', setupFeePence: '15.00', notes: '', validUntil: '',
      },
      { logo: null, proof: jpeg() },
      { send: true },
    );
    expect(q.totalGrossPence).toBe(3 * 5000 + 1500);
    expect(q.specificationText).toContain('“Club Day / 2026”');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.subject).toContain('golf ball proof');
    expect(msg.bodyHtml).toContain(`/api/public/ball-proof/${q.id}/`);

    // Balls come from stock: once approved the customer is told they've gone into print, not to a manufacturer.
    const { acceptQuoteInStore } = await import('@/lib/services/quotes');
    await acceptQuoteInStore(staff, q.id, 'Pat Print');
    const [order] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.quoteId, q.id)));
    const [confirm] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(confirm.subject).toContain('gone into print');
    expect(confirm.bodyHtml).not.toContain('manufacturer');
  });

  it('rejects a proof that is not really an image, and logo jobs without a logo', async () => {
    const { getBallRange, createBallPrintQuote } = await import('@/lib/services/ball-printing');
    const [ball] = await getBallRange(org.id);
    const base = { customerName: 'Pat Print', email: 'pat@example.com', ballId: ball.id, dozens: '1', pricePerDozenPence: '50', setupFeePence: '0' };
    const fake = new File(['<script>alert(1)</script>'], 'proof.jpg', { type: 'image/jpeg' });
    await expect(createBallPrintQuote(staff, { ...base, artworkType: 'text', textLines: ['Hi'] }, { logo: null, proof: fake }, { send: false })).rejects.toThrow(/PNG, JPG or WebP/);
    await expect(createBallPrintQuote(staff, { ...base, artworkType: 'logo' }, { logo: null, proof: jpeg() }, { send: false })).rejects.toThrow(/logo/);
  });
});

describe('catalogue prices', () => {
  it('lets a manager change a head price, with the change in the audit trail', async () => {
    const { getCatalog, updateModelPrice } = await import('@/lib/services/fitting');
    const [model] = (await getCatalog(org.id)).models;
    await expect(updateModelPrice(staff, model.id, { basePricePence: '1.00' })).rejects.toThrow(/manager/);
    await updateModelPrice(admin, model.id, { basePricePence: '298.00' });
    const [after] = (await getCatalog(org.id)).models.filter((m) => m.id === model.id);
    expect(after.basePricePence).toBe(29800);
    const events = await withTenant(org.id, (tx) =>
      tx.select().from(auditEvents).where(sql`${auditEvents.metadataJson}->>'section' = 'catalogue.model_price'`),
    );
    expect(events.at(-1)?.newValueJson).toMatchObject({ basePricePence: 29800 });
  });
});

describe('catalogue upcharges', () => {
  it('lets a manager change a shaft or grip upcharge, audited', async () => {
    const { getCatalog, updateComponentUpcharge } = await import('@/lib/services/fitting');
    const c = await getCatalog(org.id);
    const shaftCat = c.categories.find((k) => k.key === 'shaft')!;
    const shaft = c.components.find((x) => x.categoryId === shaftCat.id)!;
    await expect(updateComponentUpcharge(staff, shaft.id, { upchargePence: '5.00' })).rejects.toThrow(/manager/);
    await updateComponentUpcharge(admin, shaft.id, { upchargePence: '45.00' });
    const after = (await getCatalog(org.id)).components.find((x) => x.id === shaft.id)!;
    expect(after.upchargePence).toBe(4500);
    const events = await withTenant(org.id, (tx) =>
      tx.select().from(auditEvents).where(sql`${auditEvents.metadataJson}->>'section' = 'catalogue.component_upcharge'`),
    );
    expect(events.at(-1)?.oldValueJson).toMatchObject({ upchargePence: shaft.upchargePence });
  });
});

describe('per-club upcharges', () => {
  it('multiplies a per-club shaft upcharge by the chosen iron set size', async () => {
    const { clubsInBuild, componentPrice } = await import('@/lib/fitting-rules');
    const irons = { id: 'm1', category: 'irons', clubsInSet: 7 } as const;
    const wedge = { id: 'm2', category: 'wedge', clubsInSet: null } as const;
    const shaft = { id: 'c1', categoryId: 'shaft', metadata: { perClub: true }, upchargePence: 1000 };
    const flat = { id: 'c2', categoryId: 'shaft', metadata: {}, upchargePence: 1000 };
    const sixClubs = { id: 'c3', categoryId: 'set', metadata: { clubs: 6 }, upchargePence: 0 };
    const cat = { rules: [] };
    expect(clubsInBuild(irons, [shaft])).toBe(7);
    expect(componentPrice(cat, irons, shaft, [shaft])).toBe(7000);
    expect(componentPrice(cat, irons, shaft, [shaft, sixClubs])).toBe(6000);
    expect(componentPrice(cat, irons, flat, [flat, sixClubs])).toBe(1000);
    expect(componentPrice(cat, wedge, shaft, [shaft])).toBe(1000);
  });
});

describe('multi-club fitting quotes', () => {
  it('quotes several clubs together, line by line, priced on the server', async () => {
    const { getCatalog, createFittingQuote } = await import('@/lib/services/fitting');
    const { fitSpec } = await import('@/lib/fit-spec');
    const c = await getCatalog(org.id);
    const [driver, second] = [c.models.find((m) => m.category === 'driver')!, c.models.find((m) => m.category !== 'driver')!];
    const shaftCat = c.categories.find((k) => k.key === 'shaft')!;
    const { validComponentIds } = await import('@/lib/fitting-rules');
    const shaftId = [...validComponentIds(c, driver, shaftCat.id)][0];
    const q = await createFittingQuote(
      staff,
      {
        customerName: 'Bag Fit', email: 'bag@example.com', phone: '', validUntil: '', buildNotes: 'Standard lengths',
        builds: [
          { modelId: driver.id, componentIds: shaftId ? [shaftId] : [], notes: '9° setting' },
          { modelId: second.id, componentIds: [], notes: '' },
        ],
      },
      { send: true },
    );
    const spec = fitSpec(q.specificationJson)!;
    expect(spec.builds).toHaveLength(2);
    expect(spec.builds[0].lines[0]).toMatchObject({ label: 'Head', pricePence: driver.basePricePence });
    expect(q.totalGrossPence).toBe(spec.builds[0].totalPence + spec.builds[1].totalPence);
    expect(q.product).toBe('Custom fitting — 2 clubs');
    expect(q.specificationText.split('\n').length).toBeGreaterThan(3);
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.bodyHtml).toContain('>Head<');
    expect(msg.bodyHtml).toContain('9° setting');
  });

  it('rejects an option that does not fit the head', async () => {
    const { getCatalog, createFittingQuote } = await import('@/lib/services/fitting');
    const c = await getCatalog(org.id);
    const putter = c.models.find((m) => m.category === 'putter') ?? c.models.find((m) => m.category === 'irons')!;
    const woodShaft = c.components.find((x) => ((x.metadata as { clubCategories?: string[] })?.clubCategories ?? []).includes('driver') && !((x.metadata as { clubCategories?: string[] }).clubCategories ?? []).includes(putter.category));
    if (!woodShaft) return;
    await expect(
      createFittingQuote(staff, { customerName: 'X', email: 'x@example.com', builds: [{ modelId: putter.id, componentIds: [woodShaft.id] }] }, { send: false }),
    ).rejects.toThrow(/isn’t available/);
  });
});

describe('performance overview', () => {
  it('totals sales, ranks brands and measures turnaround from the shop’s orders', async () => {
    const { getPerformance } = await import('@/lib/analytics');
    const all = await withTenant(org.id, (tx) => tx.select().from(orders));
    const p = await getPerformance(org, 'all');
    expect(p.kpis.orders).toBe(all.length);
    expect(p.kpis.valuePence).toBe(all.reduce((s, o) => s + o.totalGrossPence, 0));
    expect(p.brands.length).toBeGreaterThan(0);
    // Brands are counted per club on multi-club fittings, so totals still add up to sales.
    const brandTotal = p.brands.reduce((s, b) => s + b.valuePence, 0);
    expect(brandTotal).toBeLessThanOrEqual(p.kpis.valuePence);
    for (const t of p.turnaround) {
      expect(t.avgDays).toBeGreaterThanOrEqual(0);
      expect(t.minDays).toBeLessThanOrEqual(t.maxDays);
    }
    // Other shops' orders never appear.
    const theirs = await getPerformance(other, 'all');
    expect(theirs.kpis.valuePence).not.toBe(p.kpis.valuePence);
  });
});

describe('csv export cells', () => {
  it('quotes commas and neutralises spreadsheet formulas', async () => {
    const { csvRow } = await import('@/lib/csv');
    expect(csvRow(['PING G440, Max', '=HYPERLINK("x")', 12.5])).toBe('"PING G440, Max","\'=HYPERLINK(""x"")",12.5');
  });
});

describe('monthly performance report', () => {
  it('covers the previous calendar month in the shop’s time zone', async () => {
    const { previousMonth } = await import('@/lib/performance-report');
    const r = previousMonth('Europe/London', new Date('2026-11-01T07:00:00Z'));
    expect(r.monthKey).toBe('2026-10');
    expect(r.label).toBe('October 2026');
    expect(r.from.toISOString()).toBe('2026-09-30T23:00:00.000Z'); // 1 Oct 00:00 BST
    expect(r.to.toISOString()).toBe('2026-11-01T00:00:00.000Z'); // 1 Nov 00:00 GMT
    expect(r.prevFrom.toISOString()).toBe('2026-08-31T23:00:00.000Z');
  });

  it('sends each finished month once, with the CSV, and records it', async () => {
    const { runMonthlyReport } = await import('@/lib/services/performance-report');
    const actor = { type: 'system' as const, label: 'test' };
    const load = async () => (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    // A shop's first run only records the month.
    await systemDb().update(organisations).set({ performanceReport: { enabled: true, recipients: [] } }).where(eq(organisations.id, org.id));
    expect(await runMonthlyReport(await load(), actor, new Date('2026-11-01T07:00:00Z'))).toBe('initialised');
    expect(await runMonthlyReport(await load(), actor, new Date('2026-11-02T07:00:00Z'))).toBe('up to date');
    // A month later, November's report goes out once.
    expect(await runMonthlyReport(await load(), actor, new Date('2026-12-01T07:00:00Z'))).toMatch(/^sent 2026-11 to 1/);
    expect(await runMonthlyReport(await load(), actor, new Date('2026-12-02T07:00:00Z'))).toBe('up to date');
    const sent = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.eventType, 'performance_report_sent')));
    expect(sent.at(-1)?.newValueJson).toMatchObject({ month: '2026-11', recipients: 1 });
    // Turned off: nothing is sent.
    const off = await load();
    await systemDb().update(organisations).set({ performanceReport: { ...off.performanceReport, enabled: false } }).where(eq(organisations.id, org.id));
    expect(await runMonthlyReport(await load(), actor, new Date('2027-01-01T07:00:00Z'))).toBe('off');
  });

  it('only lets an owner change who gets it, and checks the addresses', async () => {
    const { updatePerformanceReport } = await import('@/lib/services/performance-report');
    const fresh = (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    await expect(updatePerformanceReport({ ...staff, org: fresh }, { enabled: 'on', recipients: 'a@b.com' })).rejects.toThrow(/owner/);
    await expect(updatePerformanceReport({ ...admin, org: fresh }, { enabled: 'on', recipients: 'not-an-email' })).rejects.toThrow();
    await updatePerformanceReport({ ...admin, org: fresh }, { enabled: 'on', recipients: 'Aaron@Example.com, will@example.com' });
    const after = (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    expect(after.performanceReport).toMatchObject({ enabled: true, recipients: ['aaron@example.com', 'will@example.com'] });
  });
});

describe('supplier accounts and pre-books', () => {
  it('keeps one account per brand, manager-only, with no password field', async () => {
    const { saveAccount, listAccounts } = await import('@/lib/services/accounts');
    await expect(saveAccount(staff, null, { brand: 'Titleist' })).rejects.toThrow(/manager/);
    await saveAccount(admin, null, {
      brand: 'Titleist', accountNumber: 'DG-10442', repName: 'Sam Rep', repPhone: '07700 900123', repEmail: 'sam@example.com',
      headOfficePhone: '0345 000 0000', portalUrl: 'b2b.example.com', password: 'should-be-ignored',
    });
    await expect(saveAccount(admin, null, { brand: 'titleist' })).rejects.toThrow(/already/);
    const [a] = (await listAccounts(org.id)).filter((x) => x.brand === 'Titleist');
    expect(a).toMatchObject({ accountNumber: 'DG-10442', portalUrl: 'https://b2b.example.com' });
    expect(a).not.toHaveProperty('password');
    await expect(saveAccount(admin, null, { brand: 'Bad', repEmail: 'nope' })).rejects.toThrow();
    // Other shops can't see it.
    expect((await listAccounts(other.id)).some((x) => x.accountNumber === 'DG-10442')).toBe(false);
  });

  it('runs a pre-book from draft to delivered as stock is booked in', async () => {
    const { listAccounts } = await import('@/lib/services/accounts');
    const p = await import('@/lib/services/prebooks');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    await expect(p.createPrebook(staff, { supplierAccountId: acct.id })).rejects.toThrow(/manager/);
    const pb = await p.createPrebook(admin, { supplierAccountId: acct.id, season: '2027', expectedFrom: '2027-01-10', expectedTo: '2027-02-28' });
    expect(pb.reference).toMatch(/^PB-\d+$/);
    expect(pb.brand).toBe('Titleist');
    await expect(p.setPrebookStatus(admin, pb.id, 'placed')).rejects.toThrow(/at least one line/);
    await p.addLine(admin, pb.id, { product: 'GTS2 Driver', variant: '9° Stiff', quantity: '4', unitCostPence: '310.00' });
    await p.addLine(admin, pb.id, { product: 'T150 Irons 5-PW', quantity: '2', unitCostPence: '780', forCustomer: 'J. Smith' });
    await expect(p.receiveStock(staff, pb.id, {})).rejects.toThrow(/Place the pre-book/);
    await p.setPrebookStatus(admin, pb.id, 'placed');
    const { lines } = (await p.getPrebook(org.id, pb.reference))!;
    // Any staff member can book stock in.
    expect(await p.receiveStock(staff, pb.id, { [lines[0].id]: 2 })).toBe('part_delivered');
    await expect(p.receiveStock(staff, pb.id, { [lines[0].id]: 9 })).rejects.toThrow(/between 0 and 4/);
    await expect(p.removeLine(admin, pb.id, lines[0].id)).rejects.toThrow(/already arrived/);
    expect(await p.receiveStock(staff, pb.id, { [lines[0].id]: 4, [lines[1].id]: 2 })).toBe('delivered');
    const [row] = (await p.listPrebooks(org.id)).filter((x) => x.id === pb.id);
    expect(row).toMatchObject({ quantity: 6, received: 6, valuePence: 4 * 31000 + 2 * 78000, placedOn: expect.any(String) });
    const events = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, pb.id)));
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['prebook_created', 'prebook_line_added', 'prebook_status_changed', 'prebook_received']));
  });
});
