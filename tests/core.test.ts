import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { attachments, auditEvents, customers, messages, orders, organisations, payments, quotes, users, type Organisation } from '@/db/schema';
import { DEMO_QUOTE_TOKEN, seedDemo } from '@/db/seed';
import { orderAttention } from '@/lib/attention';
import { staffActor } from '@/lib/audit';
import { addDays, longDate, parseMoneyToPence } from '@/lib/format';
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
  it('emails "your order has been placed" when it is taken; placing it with the supplier is silent', async () => {
    const order = await createOrder(staff, {
      customerName: 'New Customer', email: 'NEW@example.com', phone: '07700 900999', brand: 'PING', category: 'Clubs', product: 'i530 Irons',
      variant: '5–PW', hand: 'Right-handed', quantity: '1', etaDate: '2026-12-04',
      sku: 'PING-I530', specificationText: 'Black dot / KBS Tour Lite R', totalGrossPence: '1099.00', depositPence: '200',
      depositMethod: 'card', internalNotes: '',
    });
    expect(order.orderNumber).toBe('COS-1052');
    expect(order.status).toBe('place_order');
    expect(order.category).toBe('Clubs');
    expect(order.specificationText).toBe('Model / variant: 5–PW\nHand: Right-handed\n\nBlack dot / KBS Tour Lite R');
    expect(order.takenByUserId).toBe(staff.userId);

    const events = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.orderId, order.id)));
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['order_created', 'payment_recorded', 'email_queued', 'email_sent']));
    expect(events.find((e) => e.eventType === 'order_created')!.actorLabel).toBe('Will Walker');
    expect(events.find((e) => e.eventType === 'email_sent')!.actorType).toBe('system');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(msg.templateType).toBe('order_confirmation');
    expect(msg.subject).toContain('Your order has been placed');
    expect(msg.bodyHtml).toContain('4 December 2026');
    expect(msg.status).toBe('sent');
    expect(msg.bodyHtml).toContain('alt="Desirable Golf"'); // retailer logo, not COS
    expect(msg.bodyHtml).not.toMatch(/\bCOS\b(?!-)/);

    // Placing with the supplier is internal, even with a new date: no second email.
    const placed = await updateOrderProgress(staff, order.id, { status: 'ordered', etaDate: '2026-12-06', supplierReference: 'PING-1' });
    expect(placed.emailed).toBe(false);
    const all = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(all).toHaveLength(1);
  });

  it('works the total out as quantity × price each', async () => {
    const order = await createOrder(staff, {
      customerName: 'Each Ellie', email: 'each@example.com', brand: 'FootJoy', category: 'Gloves', product: 'StaSof glove',
      quantity: '3', unitPricePence: '24.99', totalGrossPence: '1.00', // the browser's figure is ignored
    });
    expect(order.totalGrossPence).toBe(7497);
    expect(order.specificationText).toContain('Quantity: 3 × £24.99 each');
    const q = await createQuote(staff, { customerName: 'Each Ellie', email: 'each@example.com', brand: 'FootJoy', product: 'Socks', quantity: '2', unitPricePence: '9.50', validUntil: '' });
    expect(q.totalGrossPence).toBe(1900);
    await expect(createOrder(staff, { customerName: 'X', email: 'x-each@example.com', brand: 'B', product: 'P', unitPricePence: 'abc' })).rejects.toMatchObject({
      fieldErrors: expect.objectContaining({ totalGrossPence: expect.any(String) }),
    });
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
    // A new date alone isn't emailed (it shows on the tracking page); arrival is.
    expect(msgs.map((m) => m.templateType)).toContain('ready_for_collection');
    expect(msgs.map((m) => m.templateType)).not.toContain('eta_revised');
    const types = (await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.orderId, o.id)))).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['eta_changed', 'order_ready', 'order_collected', 'payment_recorded']));
  });

  it('staff cannot record refunds or suppress customer emails', async () => {
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1050')));
    expect(o.status).toBe('ordered');
    await expect(recordPayment(staff, o.id, { kind: 'refund', amountPence: '1', method: 'card' })).rejects.toThrow(/manager/);
    // Marking it out of stock is the one update between placing and arrival.
    await updateOrderProgress(staff, o.id, { status: 'delayed', etaDate: addDays(o.etaDate!, 1), supplierReference: o.supplierReference, notify: false });
    const msgs = await withTenant(org.id, (tx) =>
      tx.select().from(messages).where(and(eq(messages.orderId, o.id), eq(messages.templateType, 'eta_revised'))),
    );
    expect(msgs.some((m) => m.status === 'sent')).toBe(true); // notify=false ignored for staff
  });

  it('deletes a note (author or manager) without erasing it, and restores it', async () => {
    const { addNote, setNoteDeleted } = await import('@/lib/services/orders');
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1048')));
    await addNote(admin, o.id, { note: 'Wrong customer, ignore' });
    const [note] = await withTenant(org.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.orderId, o.id), eq(auditEvents.eventType, 'note_added'))).orderBy(sql`${auditEvents.createdAt} desc`).limit(1),
    );
    await expect(setNoteDeleted(staff, o.id, note.id, true)).rejects.toThrow(/manager/);
    await setNoteDeleted(admin, o.id, note.id, true);
    const types = async () =>
      (await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(sql`${auditEvents.metadataJson}->>'noteEventId' = ${note.id}`))).map((e) => e.eventType);
    expect(await types()).toEqual(['note_deleted']);
    // The note itself is still in the ledger.
    expect((await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.id, note.id))))).toHaveLength(1);
    await setNoteDeleted(admin, o.id, note.id, false);
    expect((await types()).sort()).toEqual(['note_deleted', 'note_restored']);
  });

  it('deletes an attachment (only the uploader or a manager) and restores it', async () => {
    const { addAttachment, archiveAttachment, restoreAttachment } = await import('@/lib/services/orders');
    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.orderNumber, 'COS-1048')));
    const pdf = new File([new TextEncoder().encode('%PDF-1.4 test')], 'confirmation.pdf', { type: 'application/pdf' });
    await addAttachment(admin, o.id, pdf, { category: 'other', visibility: 'internal' });
    const [att] = await withTenant(org.id, (tx) =>
      tx.select().from(attachments).where(and(eq(attachments.orderId, o.id), eq(attachments.filename, 'confirmation.pdf'))),
    );
    await expect(archiveAttachment(staff, att.id)).rejects.toThrow(/manager/);
    await archiveAttachment(admin, att.id);
    const deleted = async () => (await withTenant(org.id, (tx) => tx.select().from(attachments).where(eq(attachments.id, att.id))))[0].archivedAt;
    expect(await deleted()).not.toBeNull();
    await restoreAttachment(admin, att.id);
    expect(await deleted()).toBeNull();
  });

  it('voids a payment recorded by mistake: it stays on record but no longer counts', async () => {
    const { voidPayment, setOrderDeleted } = await import('@/lib/services/orders');
    const { paidPence } = await import('@/lib/services/common');
    const o = await createOrder(staff, { customerName: 'Void Vic', email: 'void@example.com', brand: 'PING', product: 'Putter', totalGrossPence: '300', depositPence: '100' });
    const [dep] = await withTenant(org.id, (tx) => tx.select().from(payments).where(eq(payments.orderId, o.id)));
    await expect(voidPayment(staff, o.id, dep.id, 'Typo')).rejects.toThrow(/manager/);
    await expect(voidPayment(admin, o.id, dep.id, '')).rejects.toThrow(/why/);
    await voidPayment(admin, o.id, dep.id, 'Entered on the wrong order');
    expect(await withTenant(org.id, (tx) => paidPence(tx, o.id))).toBe(0);
    await expect(voidPayment(admin, o.id, dep.id, 'Again')).rejects.toThrow(/already been voided/);
    const rows = await withTenant(org.id, (tx) => tx.select().from(payments).where(eq(payments.orderId, o.id)));
    expect(rows.map((r) => r.kind).sort()).toEqual(['deposit', 'void']); // original kept, void added
    const v = rows.find((r) => r.kind === 'void')!;
    await expect(voidPayment(admin, o.id, v.id, 'x')).rejects.toThrow(/itself a void/);
    // The ledger is still append-only underneath.
    expect(await dbError(withTenant(org.id, (tx) => tx.update(payments).set({ amountPence: 1 }).where(eq(payments.id, dep.id))))).toMatch(/not permitted|permission/);
    // With nothing left counting, the mistaken order can now be deleted.
    await setOrderDeleted(admin, o.id, true);
  });

  it('deletes an order entered by mistake (not one with money on it) and restores it', async () => {
    const { setOrderDeleted, listDeletedOrders } = await import('@/lib/services/orders');
    const paidOrder = await createOrder(staff, { customerName: 'Paid Pat', email: 'paidpat@example.com', brand: 'PING', product: 'Bag', totalGrossPence: '200', depositPence: '50' });
    await expect(setOrderDeleted(admin, paidOrder.id, true)).rejects.toThrow(/payments recorded/);
    const oops = await createOrder(staff, { customerName: 'Oops Olly', email: 'oops@example.com', brand: 'PING', product: 'Typo', totalGrossPence: '10' });
    await expect(setOrderDeleted(staff, oops.id, true)).rejects.toThrow(/manager/);
    await setOrderDeleted(admin, oops.id, true);
    expect((await listDeletedOrders(org.id)).map((o) => o.id)).toContain(oops.id);
    const [gone] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, oops.id)));
    expect(gone.archivedAt).not.toBeNull();
    await expect(updateOrderProgress(admin, oops.id, { status: 'ordered', etaDate: '2026-12-01', supplierReference: '' })).rejects.toThrow(/Restore/);
    await setOrderDeleted(admin, oops.id, false);
    const [back] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, oops.id)));
    expect(back.archivedAt).toBeNull();
    expect(back.removedAt).toBeNull();
  });

  it('moves an order across the order pad in one click each: place, arrived, collected', async () => {
    const { quickMove } = await import('@/lib/services/orders');
    const o = await createOrder(staff, { customerName: 'Quick Quinn', email: 'quick@example.com', brand: 'PING', product: 'Glove', totalGrossPence: '20', depositPence: '5' });
    let r = await quickMove(staff, o.id, 'ordered', { etaDate: '2026-11-20', supplierReference: 'PING-1' });
    expect(r).toMatchObject({ orderNumber: o.orderNumber, status: 'ordered', emailed: false }); // told when taken
    r = await quickMove(staff, o.id, 'ready');
    expect(r.status).toBe('ready');
    await expect(quickMove(staff, o.id, 'collected')).rejects.toThrow(/balance outstanding/);
    r = await quickMove(staff, o.id, 'collected', { collectWithBalance: true });
    expect(r.status).toBe('collected');
    const [after] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(after.supplierReference).toBe('PING-1');
    const sent = (await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, o.id)))).map((m) => m.templateType).sort();
    expect(sent).toEqual(['order_confirmation', 'ready_for_collection']);
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
    // A club order goes on the order pad, and the customer is told straight away that it's placed.
    expect(order.status).toBe('place_order');
    const sent = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(sent.map((m) => m.templateType)).toEqual(['order_confirmation']);
  });

  it('deletes a quote entered by mistake (its link stops working) and restores it', async () => {
    const { setQuoteDeleted, listDeletedQuotes, createApprovalLink } = await import('@/lib/services/quotes');
    const q = await createQuote(admin, { customerName: 'Quote Oops', email: 'qoops@example.com', brand: 'PING', product: 'Wrong', totalGrossPence: '10', validUntil: '' });
    const link = await createApprovalLink(admin, q.id);
    const token = link.split('/q/')[1];
    expect(await findQuoteByToken(token)).not.toBeNull();
    await expect(setQuoteDeleted(staff, q.id, true)).rejects.toThrow(/manager/);
    await setQuoteDeleted(admin, q.id, true);
    expect(await findQuoteByToken(token)).toBeNull();
    expect((await listDeletedQuotes(org.id)).map((x) => x.id)).toContain(q.id);
    await setQuoteDeleted(admin, q.id, false);
    expect((await listDeletedQuotes(org.id)).map((x) => x.id)).not.toContain(q.id);
    // Accepted quotes are orders now.
    const { acceptQuoteInStore } = await import('@/lib/services/quotes');
    await acceptQuoteInStore(admin, q.id, 'Quote Oops');
    await expect(setQuoteDeleted(admin, q.id, true)).rejects.toThrow(/now an order/);
  });

  it('adds, deletes and restores quote notes and internal notes', async () => {
    const qs = await import('@/lib/services/quotes');
    const q = await createQuote(admin, { customerName: 'Note Quote', email: 'notequote@example.com', brand: 'PING', product: 'Bag', totalGrossPence: '10', validUntil: '', internalNotes: 'Trade price check' });
    await qs.addQuoteNote(staff, q.id, { note: 'Customer prefers navy' });
    const [note] = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.quoteId, q.id), eq(auditEvents.eventType, 'note_added'))));
    await qs.setQuoteNoteDeleted(staff, q.id, note.id, true); // author can delete their own
    await expect(qs.setQuoteNoteDeleted(staff, q.id, note.id, true)).resolves.toBeUndefined(); // already deleted: no-op
    await qs.setQuoteNoteDeleted(admin, q.id, note.id, false);
    const notes = async () => (await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, q.id))))[0].internalNotes;
    await qs.updateQuoteNotes(staff, q.id, '');
    expect(await notes()).toBe('');
    await qs.restoreQuoteNotes(staff, q.id);
    expect(await notes()).toBe('Trade price check');
  });

  it('approves a quote in one click under the customer’s name', async () => {
    const { acceptQuoteForCustomer } = await import('@/lib/services/quotes');
    const q = await createQuote(staff, { customerName: 'Yes Yvonne', email: 'yes@example.com', brand: 'PING', product: 'Wedge', totalGrossPence: '150', validUntil: '' });
    const order = await acceptQuoteForCustomer(staff, q.id);
    expect(order.status).toBe('place_order');
    const [after] = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, q.id)));
    expect(after).toMatchObject({ status: 'accepted', acceptedName: 'Yes Yvonne', convertedOrderId: order.id });
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
      creditPence: '30.00', internalNotes: '',
    });
    // Out of stock at the supplier: the customer gets a delay update.
    await updateOrderProgress(staff, order.id, { status: 'delayed', etaDate: '', etaReason: 'Titleist expect stock next month.', supplierReference: '' });
    const rows = await withTenant(org.id, (tx) => tx.select().from(payments).where(eq(payments.orderId, order.id)));
    const credit = rows.find((p) => p.kind === 'credit')!;
    expect(credit.amountPence).toBe(3000);
    expect(credit.method).toBe('account');
    const { paymentTotals } = await import('@/lib/services/common');
    const t = await withTenant(org.id, (tx) => paymentTotals(tx, order.id));
    expect(t).toEqual({ paid: 2000, credit: 3000 });
    const msgs = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    const confirm = msgs.find((m) => m.templateType === 'order_confirmation')!;
    expect(confirm.bodyHtml).toContain('Account credit applied');
    expect(confirm.bodyHtml).toContain('£54.00'); // balance due
    expect(confirm.subject).toContain('Your order has been placed');
    const update = msgs.find((m) => m.templateType === 'eta_revised')!;
    expect(update.bodyHtml).toContain('Titleist expect stock next month.');
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

  it('reads a club membership export: titles stripped, mobile tidied, extra columns ignored', async () => {
    const { planImport } = await import('@/lib/services/customer-import');
    const plan = planImport(
      [
        '\ufeff"Title/Forename/Surname","Member Or Visitor","Email Address","Telephone (Mobile)","Surname/Title/Forename","Parental Email"',
        '"Mr Alan Birch","Member","alan@example.com","+447700900222","Birch, Mr Alan","mum@example.com"',
        '"Mrs Jo Ash","Member","jo@example.com","7700 900333","Ash, Mrs Jo",""',
        '"Tom Oak","Member","","07700900444 - dad","Oak, Tom",""',
      ].join('\n'),
    );
    expect(plan.columns).toMatchObject({ name: 'Title/Forename/Surname', email: 'Email Address', phone: 'Telephone (Mobile)' });
    expect(plan.rows.map((r) => [r.name, r.email, r.phone])).toEqual([
      ['Alan Birch', 'alan@example.com', '07700 900222'],
      ['Jo Ash', 'jo@example.com', '07700 900333'],
      ['Tom Oak', '', '07700900444 - dad'],
    ]);
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

  it('lists open print proofs and print jobs for the Ball Printing page', async () => {
    const { inHouseWork } = await import('@/lib/services/online-designs');
    const w = await inHouseWork(org.id, 'ball');
    expect(w.proofs.every(({ q }) => ['draft', 'sent'].includes(q.status))).toBe(true);
    expect(w.jobs.every(({ o }) => o.status !== 'collected' && (o.specificationJson as { kind: string }).kind === 'cos-ball-print')).toBe(true);
  });

  it('rejects a proof that is not really an image, and logo jobs without a logo', async () => {
    const { getBallRange, createBallPrintQuote } = await import('@/lib/services/ball-printing');
    const [ball] = await getBallRange(org.id);
    const base = { customerName: 'Pat Print', email: 'pat@example.com', ballId: ball.id, dozens: '1', pricePerDozenPence: '50', setupFeePence: '0' };
    const fake = new File(['<script>alert(1)</script>'], 'proof.jpg', { type: 'image/jpeg' });
    await expect(createBallPrintQuote(staff, { ...base, artworkType: 'text', textLines: ['Hi'] }, { logo: null, proof: fake }, { send: false })).rejects.toThrow(/PNG, JPG or WebP/);
    await expect(createBallPrintQuote(staff, { ...base, artworkType: 'logo' }, { logo: null, proof: jpeg() }, { send: false })).rejects.toThrow(/logo/);
  });

  it('files a new ball under the existing brand spelling', async () => {
    const { addBall, getBallRange } = await import('@/lib/services/ball-printing');
    const [first] = await getBallRange(org.id);
    await addBall(admin, { brand: first.brand.toUpperCase(), name: 'Case Test', colour: '#ffffff', pricePerDozenPence: '20' });
    const added = (await getBallRange(org.id)).find((b) => b.name === 'Case Test')!;
    expect(added.brand).toBe(first.brand);
  });

  it('lets a manager edit a ball, keeping one spelling per brand', async () => {
    const { updateBall, getBallRange } = await import('@/lib/services/ball-printing');
    const ball = (await getBallRange(org.id)).find((b) => b.name === 'Case Test')!;
    const brandOf = (await getBallRange(org.id)).find((b) => b.id !== ball.id)!.brand;
    await expect(updateBall(staff, ball.id, { brand: 'X', name: 'Y', pricePerDozenPence: '1' })).rejects.toThrow(/manager/);
    await updateBall(admin, ball.id, { brand: brandOf.toLowerCase(), name: 'Case Test II', colour: '#ffcc00', pricePerDozenPence: '31.50', minDozens: '2', leadTimeDays: '7' });
    const after = (await getBallRange(org.id)).find((b) => b.id === ball.id)!;
    expect(after).toMatchObject({ brand: brandOf, name: 'Case Test II', colour: '#ffcc00', pricePerDozenPence: 3150, minDozens: 2, leadTimeDays: 7 });
  });

  it('deletes a ball from the range and restores it', async () => {
    const { getBallRange, setBallRemoved, listRemovedBalls } = await import('@/lib/services/ball-printing');
    const ball = (await getBallRange(org.id)).find((b) => b.name === 'Case Test II')!;
    await expect(setBallRemoved(staff, ball.id, true)).rejects.toThrow(/manager/);
    await setBallRemoved(admin, ball.id, true);
    expect((await getBallRange(org.id, { includeInactive: true })).some((b) => b.id === ball.id)).toBe(false);
    expect((await listRemovedBalls(org.id)).map((b) => b.id)).toContain(ball.id);
    await setBallRemoved(admin, ball.id, false);
    expect((await getBallRange(org.id)).some((b) => b.id === ball.id)).toBe(true);
  });

  it('lets a customer design their own balls online: list price, review by the shop, abuse limits', async () => {
    const { getBallRange, submitBallDesign, findDesignShop, setBallDesignLink, DESIGN_LIMITS } = await import('@/lib/services/ball-printing');
    const [ball] = await getBallRange(org.id);
    const design = {
      customerName: 'Online Olly', email: 'olly@example.com', phone: '07700 900555', ballId: ball.id, artworkType: 'text',
      textLines: ['Olly', '', ''], font: 'classic', ink: 'navy', scale: '0.8', dozens: '2', notes: '',
      // A customer can't set their own price or pick another customer's record.
      pricePerDozenPence: '0.01', setupFeePence: '0', customerId: '00000000-0000-0000-0000-000000000000',
    };
    const q = await submitBallDesign('desirable-golf', design, { logo: null, proof: jpeg() }, { ip: '203.0.113.9' });
    expect(q.status).toBe('draft');
    expect(q.totalGrossPence).toBe(2 * ball.pricePerDozenPence + org.ballSetupFeePence);
    const [cust] = await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.id, q.customerId)));
    expect(cust.email).toBe('olly@example.com');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.templateType).toBe('ball_design_received');
    const [ev] = await withTenant(org.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.quoteId, q.id), eq(auditEvents.eventType, 'ball_design_submitted'))),
    );
    expect(ev.actorUserId).toBeNull();
    const { listNotifications } = await import('@/lib/services/notifications');
    const { items } = await listNotifications(org.id, admin.userId!);
    expect(items[0].title).toBe('New golf ball design to review');

    for (let i = 1; i < DESIGN_LIMITS.perIpPerHour; i++) await submitBallDesign('desirable-golf', design, { logo: null, proof: jpeg() }, { ip: '203.0.113.9' });
    await expect(submitBallDesign('desirable-golf', design, { logo: null, proof: jpeg() }, { ip: '203.0.113.9' })).rejects.toThrow(/try again later/);

    await setBallDesignLink(admin, false);
    expect(await findDesignShop('desirable-golf')).toBeNull();
    expect(await findDesignShop('fairway-demo')).toBeNull(); // no balls in that shop's range
    await expect(submitBallDesign('desirable-golf', design, { logo: null, proof: jpeg() }, { ip: '198.51.100.1' })).rejects.toThrow(/isn’t available/);
  });
});

describe('clothing cresting', () => {
  const jpeg = (name = 'photo.jpg') => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])], name, { type: 'image/jpeg' });

  it('prices per position, emails a cresting proof and goes into production when approved', async () => {
    const { createCrestQuote, updateCrestPrices } = await import('@/lib/services/cresting');
    await expect(updateCrestPrices(staff, { 'back.print': '9' })).rejects.toThrow(/manager/);
    await updateCrestPrices(admin, { 'left_chest.embroidery': '7.50', setupFeePence: '20' });
    const [fresh] = await systemDb().select().from(organisations).where(eq(organisations.id, org.id));
    const ctx = { ...admin, org: fresh };
    const q = await createCrestQuote(
      ctx,
      {
        customerName: 'Society Sam', email: 'society@example.com', phone: '', garmentType: 'apparel', garmentBrand: 'FootJoy',
        garmentDescription: 'Performance polo', garmentColour: 'Navy', garmentPricePence: '35.00', setupFeePence: '20.00',
        placements: JSON.stringify([
          { position: 'left_chest', method: 'embroidery', colour: 'white', x: 0.64, y: 0.33, w: 0.15, artwork: { type: 'logo', logo: 0 } },
          { position: 'back', method: 'print', colour: 'white', x: 0.5, y: 0.3, w: 0.4, artwork: { type: 'text', lines: ['WHEATLEY SOCIETY', ''], font: 'bold' } },
        ]),
        sizes: JSON.stringify({ M: 4, L: 5, XL: 1, Huge: 3 }),
      },
      { front: jpeg('front.jpg'), back: jpeg('back.jpg'), logos: [jpeg('club-logo.jpg'), null, null], proof: jpeg('proof.jpg') },
      { send: true },
    );
    // 10 items × (35.00 + 7.50 left chest + 9.00 back print) + 20.00 setup
    expect(q.totalGrossPence).toBe(10 * (3500 + 750 + 900) + 2000);
    expect(q.specificationText).toContain('Sizes: M × 4, L × 5, XL × 1 (10 items)');
    expect(q.specificationText).toContain('Back: Print — “WHEATLEY SOCIETY”');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.subject).toContain('cresting proof');
    expect(msg.bodyHtml).toContain(`/api/public/ball-proof/${q.id}/`);

    const { acceptQuoteInStore } = await import('@/lib/services/quotes');
    const order = await acceptQuoteInStore(ctx, q.id, 'Society Sam');
    expect(order.status).toBe('ordered');
    const [confirm] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, order.id)));
    expect(confirm.subject).toContain('gone into production');
    expect(confirm.bodyHtml).not.toContain('manufacturer');
  });

  it('lets a customer send in their own cresting design: shop prices, garment to confirm, review by the shop', async () => {
    const { submitCrestDesign, findCrestShop, setCrestDesignLink } = await import('@/lib/services/cresting');
    const design = {
      customerName: 'Online Olivia', email: 'olivia@example.com', garmentType: 'cap', garmentDescription: 'Tour cap', garmentColour: 'White',
      // No prices on the customer's form, and any sent are ignored.
      placements: JSON.stringify([{ position: 'cap_front', method: 'embroidery', colour: 'navy', x: 0.5, y: 0.42, w: 0.3, artwork: { type: 'text', lines: ['OLIVIA'] } }]),
      sizes: JSON.stringify({ 'One size': 6 }),
    };
    const q = await submitCrestDesign('desirable-golf', design, { front: jpeg(), back: null, logos: [], proof: jpeg() }, { ip: '198.51.100.7' });
    const [fresh] = await systemDb().select().from(organisations).where(eq(organisations.id, org.id));
    const { crestPrices } = await import('@/lib/cresting');
    const p = crestPrices(fresh.crestingPrices);
    expect(q.status).toBe('draft');
    expect(q.totalGrossPence).toBe(6 * p.positions.cap_front.embroidery + p.setupFeePence);
    expect(q.specificationText).toContain('garment price to be confirmed');
    const [msg] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.quoteId, q.id)));
    expect(msg.subject).toContain('clothing design');
    const { listNotifications } = await import('@/lib/services/notifications');
    expect((await listNotifications(org.id, admin.userId!)).items[0].title).toBe('New cresting design to review');

    await setCrestDesignLink(admin, false);
    expect(await findCrestShop('desirable-golf')).toBeNull();
    await expect(submitCrestDesign('desirable-golf', design, { front: jpeg(), back: null, logos: [], proof: jpeg() }, { ip: '198.51.100.8' })).rejects.toThrow(/isn’t available/);
  });

  it('deletes a position the shop does not offer, and restores it', async () => {
    const { createCrestQuote, setCrestPositionRemoved, updateCrestPrices } = await import('@/lib/services/cresting');
    const { crestPrices, offeredPositions } = await import('@/lib/cresting');
    const fresh = async () => (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    await expect(setCrestPositionRemoved(staff, 'cap_side', true)).rejects.toThrow(/manager/);
    await setCrestPositionRemoved({ ...admin, org: await fresh() }, 'cap_side', true);
    // Saving prices afterwards keeps it deleted.
    await updateCrestPrices({ ...admin, org: await fresh() }, { 'cap_front.print': '5.50' });
    const o = await fresh();
    expect(offeredPositions(crestPrices(o.crestingPrices)).some((p) => p.key === 'cap_side')).toBe(false);
    const cap = {
      customerName: 'Cap Carl', email: 'cap@example.com', garmentType: 'cap', garmentDescription: 'Cap', garmentPricePence: '0', setupFeePence: '0',
      placements: JSON.stringify([{ position: 'cap_side', method: 'print', x: 0.5, y: 0.5, w: 0.2, artwork: { type: 'text', lines: ['C'] } }]),
      sizes: JSON.stringify({ 'One size': 1 }),
    };
    await expect(createCrestQuote({ ...admin, org: o }, cap, { front: jpeg(), back: jpeg(), logos: [], proof: jpeg() }, { send: false })).rejects.toThrow(/isn’t offered/);
    await setCrestPositionRemoved({ ...admin, org: o }, 'cap_side', false);
    expect(offeredPositions(crestPrices((await fresh()).crestingPrices)).some((p) => p.key === 'cap_side')).toBe(true);
  });

  it('needs a garment photo, a back photo for back positions, and sizes', async () => {
    const { createCrestQuote } = await import('@/lib/services/cresting');
    const base = {
      customerName: 'X', email: 'x-crest@example.com', garmentType: 'apparel', garmentDescription: 'Polo', garmentPricePence: '0', setupFeePence: '0',
      placements: JSON.stringify([{ position: 'back', method: 'print', x: 0.5, y: 0.3, w: 0.4, artwork: { type: 'text', lines: ['Hi'] } }]),
      sizes: JSON.stringify({ M: 1 }),
    };
    const files = { front: jpeg(), back: null, logos: [], proof: jpeg() };
    await expect(createCrestQuote(admin, base, { ...files, front: null }, { send: false })).rejects.toThrow(/photo of the garment/);
    await expect(createCrestQuote(admin, base, files, { send: false })).rejects.toThrow(/back photo/);
    await expect(createCrestQuote(admin, { ...base, sizes: '{}' }, { ...files, back: jpeg() }, { send: false })).rejects.toThrow(/how many/);
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

  it('deletes and restores heads and whole brands', async () => {
    const { getCatalog, setCatalogRemoved, listRemovedCatalog } = await import('@/lib/services/fitting');
    const before = await getCatalog(org.id, { includeInactive: true });
    const model = before.models.at(-1)!;
    await expect(setCatalogRemoved(staff, 'model', model.id, true)).rejects.toThrow(/manager/);
    await setCatalogRemoved(admin, 'model', model.id, true);
    expect((await getCatalog(org.id, { includeInactive: true })).models.some((m) => m.id === model.id)).toBe(false);
    expect((await listRemovedCatalog(org.id)).map((r) => r.id)).toContain(model.id);
    await setCatalogRemoved(admin, 'model', model.id, false);
    expect((await getCatalog(org.id)).models.some((m) => m.id === model.id)).toBe(true);

    // A brand takes its heads with it, and brings them back on restore.
    const brand = before.brands.find((b) => before.models.some((m) => m.brandId === b.id))!;
    const heads = before.models.filter((m) => m.brandId === brand.id && m.active).map((m) => m.id);
    await setCatalogRemoved(admin, 'brand', brand.id, true);
    const gone = await getCatalog(org.id, { includeInactive: true });
    expect(gone.brands.some((b) => b.id === brand.id)).toBe(false);
    expect(gone.models.some((m) => m.brandId === brand.id)).toBe(false);
    expect((await listRemovedCatalog(org.id)).filter((r) => heads.includes(r.id))).toHaveLength(0); // listed under the brand
    await setCatalogRemoved(admin, 'brand', brand.id, false);
    const back = await getCatalog(org.id);
    expect(heads.every((id) => back.models.some((m) => m.id === id))).toBe(true);
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
    // Deleted orders are left out of Performance.
    const all = (await withTenant(org.id, (tx) => tx.select().from(orders))).filter((o) => !o.removedAt);
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

  it('turns one automatic email off and back on without touching the others', async () => {
    const { setAutomation } = await import('@/lib/services/admin');
    const { TEMPLATE_KEYS } = await import('@/lib/email/templates');
    const fresh = async () => (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    await expect(setAutomation(staff, 'workshop_ready', false)).rejects.toThrow(/admin/);
    await setAutomation({ ...admin, org: await fresh() }, 'workshop_ready', false);
    let a = (await fresh()).emailAutomations;
    expect(a.workshop_ready).toBe(false);
    // Every other email stays on (including ones added after the shop's settings were first saved).
    expect(TEMPLATE_KEYS.filter((k) => k !== 'workshop_ready').every((k) => a[k] !== false)).toBe(true);
    await setAutomation({ ...admin, org: await fresh() }, 'workshop_ready', true);
    a = (await fresh()).emailAutomations;
    expect(TEMPLATE_KEYS.every((k) => a[k] === true)).toBe(true);
  });

  it('deletes a team member (not yourself) and restores them', async () => {
    const { setUserDeleted, listDeletedUsers, createUser } = await import('@/lib/services/admin');
    await expect(setUserDeleted(staff, admin.userId!, true)).rejects.toThrow(/admin/);
    await expect(setUserDeleted(admin, admin.userId!, true)).rejects.toThrow(/your own account/);
    await setUserDeleted(admin, staff.userId!, true);
    const [will] = await systemDb().select().from(users).where(eq(users.id, staff.userId!));
    expect(will.active).toBe(false);
    expect((await listDeletedUsers(org.id)).map((u) => u.id)).toContain(staff.userId);
    await expect(createUser(admin, { name: 'Will Again', email: will.email, role: 'staff', canSignIn: 'on', password: 'long-enough-pass' })).rejects.toThrow(/Restore them/);
    await setUserDeleted(admin, staff.userId!, false);
    const [back] = await systemDb().select().from(users).where(eq(users.id, staff.userId!));
    expect(back).toMatchObject({ active: true, removedAt: null });
  });

  it('deletes a customer with nothing open, and restores them when they come back', async () => {
    const { setCustomerDeleted, listDeletedCustomers } = await import('@/lib/services/admin');
    const order = await createOrder(staff, { customerName: 'Gone Gary', email: 'gary@example.com', brand: 'PING', product: 'Glove', totalGrossPence: '20' });
    const id = order.customerId;
    await expect(setCustomerDeleted(staff, id, true)).rejects.toThrow(/manager/);
    await expect(setCustomerDeleted(admin, id, true)).rejects.toThrow(/1 open order/);
    await updateOrderProgress(admin, order.id, { status: 'ready', etaDate: '', supplierReference: '' });
    await recordPayment(admin, order.id, { kind: 'payment', amountPence: '20', method: 'card' });
    await updateOrderProgress(admin, order.id, { status: 'collected', etaDate: '', supplierReference: '' });
    await setCustomerDeleted(admin, id, true);
    const archived = async () => (await withTenant(org.id, (tx) => tx.select().from(customers).where(eq(customers.id, id))))[0].archivedAt;
    expect(await archived()).not.toBeNull();
    expect((await listDeletedCustomers(org.id)).map((c) => c.id)).toContain(id);
    // Taking a new order with their email brings them back, rather than failing on a duplicate email.
    const again = await createOrder(staff, { customerName: 'Gary', email: 'GARY@example.com', brand: 'PING', product: 'Tees', totalGrossPence: '5' });
    expect(again.customerId).toBe(id);
    expect(await archived()).toBeNull();
  });

  it('edits, deletes and restores account notes', async () => {
    const acc = await import('@/lib/services/accounts');
    await acc.saveAccount(admin, null, { brand: 'Cleveland', notes: 'Pre-book by 30 Nov' });
    const c = (await acc.listAccounts(org.id)).find((x) => x.brand === 'Cleveland')!;
    await expect(acc.updateAccountNotes(staff, c.id, '')).rejects.toThrow(/manager/);
    await acc.updateAccountNotes(admin, c.id, '');
    expect((await acc.deletedAccountNotes(org.id)).get(c.id)).toBe('Pre-book by 30 Nov');
    await acc.restoreAccountNotes(admin, c.id);
    expect((await acc.listAccounts(org.id)).find((x) => x.id === c.id)!.notes).toBe('Pre-book by 30 Nov');
    expect((await acc.deletedAccountNotes(org.id)).has(c.id)).toBe(false);
  });

  it('deletes an account card and restores it', async () => {
    const acc = await import('@/lib/services/accounts');
    await acc.saveAccount(admin, null, { brand: 'Wilson' });
    const w = (await acc.listAccounts(org.id)).find((x) => x.brand === 'Wilson')!;
    await expect(acc.setAccountDeleted(staff, w.id, true)).rejects.toThrow(/manager/);
    await acc.setAccountDeleted(admin, w.id, true);
    expect((await acc.listAccounts(org.id, { includeInactive: true })).some((x) => x.id === w.id)).toBe(false);
    expect((await acc.listDeletedAccounts(org.id)).map((x) => x.id)).toContain(w.id);
    await expect(acc.saveAccount(admin, null, { brand: 'wilson' })).rejects.toThrow(/Restore it/);
    await acc.setAccountDeleted(admin, w.id, false);
    expect((await acc.listAccounts(org.id)).some((x) => x.id === w.id)).toBe(true);
  });

  it('books in everything outstanding in one click', async () => {
    const { listAccounts } = await import('@/lib/services/accounts');
    const p = await import('@/lib/services/prebooks');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    const pb = await p.createPrebook(admin, { supplierAccountId: acct.id, season: 'Quick' });
    await p.addLine(admin, pb.id, { product: 'Pro V1', quantity: '12' });
    await p.addLine(admin, pb.id, { product: 'AVX', quantity: '6' });
    await expect(p.receiveAll(staff, pb.id)).rejects.toThrow(/Place the pre-book/);
    await p.setPrebookStatus(admin, pb.id, 'placed');
    const lines = (await p.getPrebook(org.id, pb.reference))!.lines;
    await p.receiveStock(staff, pb.id, { [lines[0].id]: 4 }); // part delivery first
    expect(await p.receiveAll(staff, pb.id)).toBe('delivered');
    expect((await p.getPrebook(org.id, pb.reference))!.lines.every((l) => l.quantityReceived === l.quantity)).toBe(true);
    await p.setPrebookDeleted(admin, pb.id, true); // keep Performance tests unaffected
  });

  it('deletes a pre-book line and restores it, but not once stock has arrived', async () => {
    const { listAccounts } = await import('@/lib/services/accounts');
    const p = await import('@/lib/services/prebooks');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    const pb = await p.createPrebook(admin, { supplierAccountId: acct.id, season: 'Lines' });
    await p.addLine(admin, pb.id, { product: 'Pro V1', quantity: '12' });
    await p.addLine(admin, pb.id, { product: 'AVX', quantity: '6' });
    let d = (await p.getPrebook(org.id, pb.reference))!;
    const avx = d.lines.find((l) => l.product === 'AVX')!;
    await expect(p.removeLine(staff, pb.id, avx.id)).rejects.toThrow(/manager/);
    await p.removeLine(admin, pb.id, avx.id);
    d = (await p.getPrebook(org.id, pb.reference))!;
    expect(d.lines.map((l) => l.product)).toEqual(['Pro V1']);
    expect(d.deletedLines.map((l) => l.product)).toEqual(['AVX']);
    await p.restoreLine(admin, pb.id, avx.id);
    d = (await p.getPrebook(org.id, pb.reference))!;
    expect(d.lines).toHaveLength(2);
    // Once some has arrived, the line stays.
    await p.setPrebookStatus(admin, pb.id, 'placed');
    const proV1 = d.lines.find((l) => l.product === 'Pro V1')!;
    await p.receiveStock(admin, pb.id, { [proV1.id]: 3 });
    await expect(p.removeLine(admin, pb.id, proV1.id)).rejects.toThrow(/already arrived/);
    // Tidy up: a deleted pre-book's arrivals don't count in Performance.
    await p.setPrebookDeleted(admin, pb.id, true);
  });

  it('edits, deletes and restores pre-book notes', async () => {
    const { listAccounts } = await import('@/lib/services/accounts');
    const p = await import('@/lib/services/prebooks');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    const pb = await p.createPrebook(admin, { supplierAccountId: acct.id, season: 'Notes', notes: 'Deadline 30 Nov' });
    await expect(p.updatePrebookNotes(staff, pb.id, '')).rejects.toThrow(/manager/);
    await p.updatePrebookNotes(admin, pb.id, '');
    expect(await p.deletedPrebookNotes(org.id, pb.id)).toBe('Deadline 30 Nov');
    await p.restorePrebookNotes(admin, pb.id);
    expect((await p.getPrebook(org.id, pb.reference))!.prebook.notes).toBe('Deadline 30 Nov');
    expect(await p.deletedPrebookNotes(org.id, pb.id)).toBeNull();
    await p.setPrebookDeleted(admin, pb.id, true);
  });

  it('deletes a pre-book entered by mistake and restores it', async () => {
    const { listAccounts } = await import('@/lib/services/accounts');
    const p = await import('@/lib/services/prebooks');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    const pb = await p.createPrebook(admin, { supplierAccountId: acct.id, season: 'Oops' });
    await expect(p.setPrebookDeleted(staff, pb.id, true)).rejects.toThrow(/manager/);
    await p.setPrebookDeleted(admin, pb.id, true);
    expect((await p.listPrebooks(org.id, { includeArchived: true })).some((x) => x.id === pb.id)).toBe(false);
    expect((await p.listDeletedPrebooks(org.id)).map((x) => x.id)).toContain(pb.id);
    await expect(p.addLine(admin, pb.id, { product: 'X', quantity: '1' })).rejects.toThrow(/deleted/);
    await p.setPrebookDeleted(admin, pb.id, false);
    expect((await p.listPrebooks(org.id)).some((x) => x.id === pb.id)).toBe(true);
  });
});

describe('performance: pre-book arrivals', () => {
  it('values stock booked in during the period and checks it against the expected date', async () => {
    const { getPerformance } = await import('@/lib/analytics');
    const a = (await getPerformance(org, 'all')).arrivals;
    // From the Titleist pre-book delivered earlier: 4 drivers at £310 and 2 iron sets at £780, due by Feb 2027.
    const titleist = a.byBrand.find((b) => b.brand === 'Titleist')!;
    expect(titleist.items).toBe(6);
    expect(titleist.valuePence).toBe(4 * 31000 + 2 * 78000);
    expect(titleist.onTimePct).toBe(100);
    expect(a.receivedValuePence).toBeGreaterThanOrEqual(titleist.valuePence);
    const csv = (await import('@/lib/performance-report')).performanceCsv(org, await getPerformance(org, 'all'), '2026-10-17');
    expect(csv).toContain('Pre-book stock received by brand');
    expect(csv).toContain('Titleist,6,2800.00,100,');
  });
});

describe('monthly report: pre-book arrivals', () => {
  it('includes the pre-book section when there is activity, and leaves it out when there is none', async () => {
    const { getPerformance } = await import('@/lib/analytics');
    const { renderPerformanceEmail } = await import('@/lib/email/performance-email');
    const withActivity = renderPerformanceEmail(org, await getPerformance(org, 'all'), 'https://example.com');
    expect(withActivity.html).toContain('Pre-book arrivals');
    expect(withActivity.text).toContain('Pre-book arrivals:');
    const quiet = renderPerformanceEmail(other, await getPerformance(other, 'all'), 'https://example.com');
    expect(quiet.html).not.toContain('Pre-book arrivals');
  });
});

describe('account logos', () => {
  it('stores a real image for a manager and rejects anything else', async () => {
    const { listAccounts, setAccountLogo, accountLogoUrl } = await import('@/lib/services/accounts');
    const acct = (await listAccounts(org.id)).find((x) => x.brand === 'Titleist')!;
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'logo.png', { type: 'image/png' });
    const fake = new File(['<svg onload=alert(1)>'], 'logo.png', { type: 'image/png' });
    await expect(setAccountLogo(staff, acct.id, png)).rejects.toThrow(/manager/);
    await expect(setAccountLogo(admin, acct.id, fake)).rejects.toThrow(/PNG, JPG or WebP/);
    await setAccountLogo(admin, acct.id, png);
    const after = (await listAccounts(org.id)).find((x) => x.id === acct.id)!;
    expect(after.logoMime).toBe('image/png');
    expect(accountLogoUrl(after)).toMatch(new RegExp(`^/api/account-logo/${acct.id}\\?v=`));
  });
});

describe('workshop', () => {
  it('checks clubs in, emails the customer, handles a parts delay, and emails when ready', async () => {
    const ws = await import('@/lib/services/workshop');
    // Dates relative to today, so "finished before the promised date" holds whenever the suite runs.
    const today = new Date().toISOString().slice(0, 10);
    const promised = addDays(today, 7);
    const revised = addDays(today, 11);
    const job = await ws.checkInClubs(staff, {
      customerName: 'Rita Regrip', email: 'rita@example.com', phone: '07700 111999', etaDate: promised, notes: 'Bag tag 12',
      items: [
        { club: 'Irons 5-PW', work: 'Regrip', parts: 'Golf Pride MCC midsize', quantity: '6', pricePence: '78.00' },
        { club: 'Driver', work: 'Loft & lie adjustment', pricePence: '10' },
      ],
    });
    expect(job.reference).toMatch(/^WS-\d+$/);
    const sent = async (template: string) =>
      withTenant(org.id, (tx) => tx.select().from(messages).where(and(eq(messages.workshopJobId, job.id), eq(messages.templateType, template as never))));
    const [checkIn] = await sent('workshop_checked_in');
    expect(checkIn.subject).toContain(job.reference);
    expect(checkIn.bodyHtml).toContain('Golf Pride MCC midsize');
    expect(checkIn.bodyHtml).toContain('£88.00');

    // Waiting for parts needs a reason the customer will see.
    await expect(ws.updateWorkshopProgress(staff, job.id, { status: 'waiting_parts', etaDate: revised })).rejects.toThrow(/waiting for/);
    await ws.updateWorkshopProgress(staff, job.id, { status: 'waiting_parts', etaDate: revised, delayReason: 'Waiting for midsize grips to arrive' });
    const [delay] = await sent('workshop_delayed');
    expect(delay.bodyHtml).toContain('Waiting for midsize grips to arrive');
    expect(delay.bodyHtml).toContain(longDate(revised));

    // Staff can't cancel; managers can.
    await expect(ws.updateWorkshopProgress(staff, job.id, { status: 'cancelled' })).rejects.toThrow(/manager/);

    await ws.updateWorkshopProgress(staff, job.id, { status: 'ready', etaDate: revised });
    const [ready] = await sent('workshop_ready');
    expect(ready.subject).toContain('ready to collect');
    const d = (await ws.getJob(org.id, job.reference))!;
    expect(d.job.status).toBe('ready');
    expect(d.job.readyAt).toBeTruthy();
    expect(d.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['workshop_job_created', 'workshop_status_changed', 'workshop_eta_changed']));
    // Other shops never see it.
    expect((await ws.listJobs(other.id)).some((j) => j.id === job.id)).toBe(false);
  });

  it('notifies other staff about check-ins and ready jobs', async () => {
    const { listNotifications } = await import('@/lib/services/notifications');
    const n = await listNotifications(org.id, admin.userId!);
    const titles = n.items.map((i) => i.title);
    expect(titles).toContain('Clubs checked in to the workshop');
    expect(titles).toContain('Workshop job ready');
    expect(n.items.find((i) => i.title === 'Workshop job ready')!.href).toMatch(/^\/workshop\/WS-/);
  });

  it('prices a line as price each × quantity', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(staff, {
      customerName: 'Grip Gary', email: 'gripgary@example.com', etaDate: '',
      items: [{ club: 'Irons 5-PW', work: 'Regrip', parts: 'Golf Pride MCC', quantity: '6', unitPricePence: '13.00' }],
    });
    await ws.addWorkshopItem(staff, job.id, { club: 'Wedges', work: 'Regrip', quantity: '2', unitPricePence: '12.50' });
    const d = (await ws.getJob(org.id, job.reference))!;
    expect(d.items.map((i) => i.pricePence)).toEqual([7800, 2500]);
    const spec = ws.jobSpec(d.job, d.items);
    expect(spec.totalPence).toBe(10300);
    expect(spec.builds[0].lines[0].value).toContain('£13.00 each');
  });

  it('does not email the customer when only the ready date changes', async () => {
    const ws = await import('@/lib/services/workshop');
    const today = new Date().toISOString().slice(0, 10);
    const job = await ws.checkInClubs(staff, { customerName: 'Date Dan', email: 'datedan@example.com', etaDate: addDays(today, 3), items: [{ club: 'Putter', work: 'Regrip', pricePence: '15' }] });
    const r = await ws.updateWorkshopProgress(staff, job.id, { status: 'in_progress', etaDate: addDays(today, 6) });
    expect(r.emailed).toBe(false);
    const sent = (await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.workshopJobId, job.id)))).map((m) => m.templateType);
    expect(sent).toEqual(['workshop_checked_in']);
  });

  it('moves a job along in one click each: start, waiting for parts, parts in, ready, collected', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(staff, { customerName: 'Quick Jo', email: 'quickjo@example.com', etaDate: addDays(new Date().toISOString().slice(0, 10), 5), items: [{ club: 'Irons', work: 'Regrip', pricePence: '60' }] });
    expect((await ws.quickMoveJob(staff, job.id, 'in_progress')).status).toBe('in_progress');
    await expect(ws.quickMoveJob(staff, job.id, 'waiting_parts')).rejects.toThrow(/waiting for/);
    const parts = await ws.quickMoveJob(staff, job.id, 'waiting_parts', { delayReason: 'Grips on order' });
    expect(parts).toMatchObject({ status: 'waiting_parts', emailed: true });
    await ws.quickMoveJob(staff, job.id, 'in_progress');
    const ready = await ws.quickMoveJob(staff, job.id, 'ready');
    expect(ready).toMatchObject({ reference: job.reference, status: 'ready', emailed: true });
    expect((await ws.quickMoveJob(staff, job.id, 'collected')).status).toBe('collected');
    const d = (await ws.getJob(org.id, job.reference))!;
    expect(d.job.etaDate).toBe(job.etaDate); // ready date kept
    expect(d.job.delayReason).toBe('');
  });

  it('edits, deletes and restores a job’s internal notes', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(staff, { customerName: 'Notes Nell', email: 'notes@example.com', etaDate: '', notes: 'Bag tag 7', items: [{ club: 'Driver', work: 'Regrip', pricePence: '10' }] });
    const notes = async () => (await ws.getJob(org.id, job.reference))!.job.notes;
    await ws.updateJobNotes(staff, job.id, 'Bag tag 7, customer bringing own grips');
    expect(await notes()).toBe('Bag tag 7, customer bringing own grips');
    await ws.updateJobNotes(staff, job.id, '');
    expect(await notes()).toBe('');
    await ws.restoreJobNotes(staff, job.id);
    expect(await notes()).toBe('Bag tag 7, customer bringing own grips');
    await expect(ws.restoreJobNotes(staff, job.id)).rejects.toThrow(/no deleted notes/);
  });

  it('deletes a club from a job (even once ready) and restores it', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(admin, {
      customerName: 'Two Clubs', email: 'twoclubs@example.com', etaDate: '',
      items: [{ club: 'Driver', work: 'Regrip', pricePence: '10' }, { club: 'Putter', work: 'Regrip', pricePence: '12' }],
    });
    await ws.updateWorkshopProgress(admin, job.id, { status: 'ready', etaDate: '' }, { notify: false });
    let d = (await ws.getJob(org.id, job.reference))!;
    const putter = d.items.find((i) => i.club === 'Putter')!;
    await ws.removeWorkshopItem(admin, job.id, putter.id);
    d = (await ws.getJob(org.id, job.reference))!;
    expect(d.items.map((i) => i.club)).toEqual(['Driver']);
    expect(d.deletedItems.map((i) => i.club)).toEqual(['Putter']);
    await expect(ws.removeWorkshopItem(admin, job.id, d.items[0].id)).rejects.toThrow(/at least one club/);
    await ws.restoreWorkshopItem(staff, job.id, putter.id);
    d = (await ws.getJob(org.id, job.reference))!;
    expect(d.items).toHaveLength(2);
    expect(d.deletedItems).toHaveLength(0);
  });

  it('deletes a job entered by mistake and restores it', async () => {
    const { checkInClubs, setJobDeleted, listJobs, listDeletedJobs, updateWorkshopProgress } = await import('@/lib/services/workshop');
    const job = await checkInClubs(admin, {
      customerName: 'Mistake Mo', email: 'mistake@example.com', etaDate: '', items: [{ club: 'Driver', work: 'Regrip', pricePence: '10' }],
    });
    await expect(setJobDeleted(staff, job.id, true)).rejects.toThrow(/manager/);
    await setJobDeleted(admin, job.id, true);
    expect((await listJobs(org.id)).some((j) => j.id === job.id)).toBe(false);
    expect((await listDeletedJobs(org.id)).map((j) => j.id)).toContain(job.id);
    await expect(updateWorkshopProgress(admin, job.id, { status: 'ready', etaDate: '' })).rejects.toThrow(/deleted/);
    await setJobDeleted(admin, job.id, false);
    expect((await listJobs(org.id)).some((j) => j.id === job.id)).toBe(true);
  });
});

describe('workshop collection reminders', () => {
  it('reminds once a ready job has waited past the threshold, and not again until the next period', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(staff, { customerName: 'Uma Uncollected', email: 'uma@example.com', items: [{ club: 'Putter', work: 'Regrip', pricePence: '15' }] });
    await ws.updateWorkshopProgress(staff, job.id, { status: 'ready' });
    const fresh = (await systemDb().select().from(organisations).where(eq(organisations.id, org.id)))[0];
    const later = new Date(Date.now() + (fresh.readyUncollectedDays + 1) * 86_400_000);
    expect(await ws.sendWorkshopReminders(fresh, new Date())).toBe(0); // not waited long enough
    expect(await ws.sendWorkshopReminders(fresh, later)).toBeGreaterThanOrEqual(1);
    const [m] = await withTenant(org.id, (tx) =>
      tx.select().from(messages).where(and(eq(messages.workshopJobId, job.id), eq(messages.templateType, 'workshop_reminder'))),
    );
    expect(m.subject).toContain('Reminder');
    const remindersForJob = async () =>
      (await withTenant(org.id, (tx) =>
        tx.select().from(messages).where(and(eq(messages.workshopJobId, job.id), eq(messages.templateType, 'workshop_reminder'))),
      )).length;
    await ws.sendWorkshopReminders(fresh, new Date(later.getTime() + 86_400_000));
    expect(await remindersForJob()).toBe(1); // once per period
    // Collected jobs are never reminded.
    await ws.updateWorkshopProgress(staff, job.id, { status: 'collected' });
    await ws.sendWorkshopReminders(fresh, new Date(later.getTime() + 30 * 86_400_000));
    expect(await remindersForJob()).toBe(1);
  });
});

describe('workshop customer link', () => {
  it('puts a private progress link in workshop emails that shows only customer-safe details', async () => {
    const ws = await import('@/lib/services/workshop');
    const { findWorkshopByToken, findOrderByTrackingToken } = await import('@/lib/services/public');
    const job = await ws.checkInClubs(staff, {
      customerName: 'Lena Link', email: 'lena@example.com', notes: 'INTERNAL: bag tag 7',
      items: [{ club: 'Driver', work: 'Reshaft', parts: 'Ventus Blue 6S', pricePence: '45' }],
    });
    const [m] = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.workshopJobId, job.id)));
    const token = /\/w\/([\w-]+)/.exec(m.bodyHtml)?.[1];
    expect(token).toBeTruthy();
    expect(m.bodyHtml).toContain('Check your clubs');
    const d = (await findWorkshopByToken(token!))!;
    expect(d.job.reference).toBe(job.reference);
    expect(d.items[0]).toMatchObject({ club: 'Driver', work: 'Reshaft' });
    expect(JSON.stringify(d)).not.toContain('INTERNAL');
    // A workshop link never opens an order, and nonsense tokens open nothing.
    expect(await findOrderByTrackingToken(token!)).toBeNull();
    expect(await findWorkshopByToken('x'.repeat(43))).toBeNull();
    // The delay reason is shown only while waiting for parts.
    await ws.updateWorkshopProgress(staff, job.id, { status: 'waiting_parts', delayReason: 'Shaft on back order' });
    expect((await findWorkshopByToken(token!))!.job.delayReason).toBe('Shaft on back order');
    await ws.updateWorkshopProgress(staff, job.id, { status: 'ready' });
    expect((await findWorkshopByToken(token!))!.job.delayReason).toBe('');
  });
});

describe('performance: workshop', () => {
  it('counts jobs, clubs, value and work types, and measures turnaround and on-time against the promised date', async () => {
    const { getPerformance } = await import('@/lib/analytics');
    const w = (await getPerformance(org, 'all')).workshop;
    expect(w.checkedIn).toBeGreaterThanOrEqual(3);
    expect(w.clubs).toBeGreaterThanOrEqual(w.checkedIn);
    expect(w.byWork.map((r) => r.name)).toEqual(expect.arrayContaining(['Regrip', 'Reshaft']));
    expect(w.finished).toBeGreaterThanOrEqual(2);
    expect(w.avgTurnaroundDays).not.toBeNull();
    // Jobs finished well before their promised dates count as on time.
    expect(w.onTimePct).toBe(100);
    expect(w.waitedForPartsPct).toBeGreaterThan(0);
    const csv = (await import('@/lib/performance-report')).performanceCsv(org, await getPerformance(org, 'all'), '2026-10-17');
    expect(csv).toContain('Workshop work done');
  });
});

describe('monthly report: workshop', () => {
  it('includes the workshop section when there is activity, and leaves it out otherwise', async () => {
    const { getPerformance } = await import('@/lib/analytics');
    const { renderPerformanceEmail } = await import('@/lib/email/performance-email');
    const busy = renderPerformanceEmail(org, await getPerformance(org, 'all'), 'https://example.com');
    expect(busy.html).toContain('>Workshop<');
    expect(busy.html).toContain('Regrip');
    expect(busy.html).not.toContain(' sold<span'); // workshop work is counted in clubs
    expect(busy.text).toContain('Workshop:');
    const quiet = renderPerformanceEmail(other, await getPerformance(other, 'all'), 'https://example.com');
    expect(quiet.html).not.toContain('>Workshop<');
  });
});

describe('customer page: workshop jobs', () => {
  it('lists only that customer’s workshop jobs', async () => {
    const ws = await import('@/lib/services/workshop');
    const all = await ws.listJobs(org.id);
    const one = all[0];
    const mine = await ws.listJobs(org.id, { customerId: one.customerId });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((j) => j.customerId === one.customerId)).toBe(true);
    expect(mine.length).toBeLessThan(all.length);
  });
});

describe('workshop search', () => {
  it('finds jobs by reference, customer, phone digits and club work or parts', async () => {
    const ws = await import('@/lib/services/workshop');
    const job = await ws.checkInClubs(staff, {
      customerName: 'Sid Search', email: 'sid@example.com', phone: '07700 123 456',
      items: [{ club: 'Putter', work: 'Regrip', parts: 'SuperStroke Zenergy', pricePence: '25' }],
    });
    for (const q of [job.reference, 'Sid Sea', 'sid@example', '07700123456', 'zenergy', 'PUTTER']) {
      const hits = await ws.listJobs(org.id, { q });
      expect(hits.map((h) => h.id), `search "${q}"`).toContain(job.id);
    }
    expect((await ws.listJobs(org.id, { q: 'no-such-thing-xyz' })).length).toBe(0);
    // Wildcards in the search are taken literally.
    expect((await ws.listJobs(org.id, { q: '%' })).length).toBe(0);
  });
});

describe('full export', () => {
  it('includes workshop jobs and their clubs, and never password hashes', async () => {
    const { buildExport } = await import('@/lib/services/backups');
    const data = await withTenant(org.id, (tx) => buildExport(tx, org.id));
    expect(data.workshopJobs.length).toBeGreaterThan(0);
    expect(data.workshopItems.length).toBeGreaterThan(0);
    expect(data.workshopJobs.every((j) => j.organisationId === org.id)).toBe(true);
    expect(JSON.stringify(data.users)).not.toContain('passwordHash');
  });

  it('includes the Custom Fitting catalogue with edited prices, and saved fitting builds', async () => {
    const { buildExport, EXPORT_VERSION } = await import('@/lib/services/backups');
    const data = await withTenant(org.id, (tx) => buildExport(tx, org.id));
    expect(EXPORT_VERSION).toBe(2);
    expect(data.catalogue.brands.length).toBeGreaterThan(0);
    expect(data.catalogue.productModels.length).toBeGreaterThan(0);
    expect(data.catalogue.components.length).toBeGreaterThan(0);
    expect(data.catalogue.componentCategories.length).toBeGreaterThan(0);
    // The head whose price a manager edited earlier keeps the edited price.
    expect(data.catalogue.productModels.some((m) => m.basePricePence === 29800)).toBe(true);
    expect(data.configurationQuotes.length).toBeGreaterThan(0);
    // Never another shop's catalogue.
    expect(data.catalogue.brands.every((b) => b.organisationId === org.id)).toBe(true);
  });
});
