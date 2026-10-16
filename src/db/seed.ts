import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { DB } from './index';
import {
  auditEvents,
  brands,
  componentCategories,
  components,
  productModels,
  customers,
  messages,
  orders,
  organisations,
  payments,
  quotes,
  trackingTokens,
  users,
  type EmailAutomationKey,
  type OrderStatus,
} from './schema';
import { renderEmail } from '../lib/email/templates';
import { addDays } from '../lib/format';
import { hashToken } from '../lib/tokens';

export const DEMO_PASSWORD = 'cos-demo-2026';

/** Matches www.desirablegolf.co.uk: sand header, navy accents, Barlow headings, square buttons. */
export const DESIRABLE_GOLF_BRAND = {
  brandColor: '#c8b69a',
  brandTheme: {
    logoUrl: 'https://www.desirablegolf.co.uk/cdn/shop/files/BLACK_DG_Horizontal.png?height=120&v=1645526612',
    websiteUrl: 'https://www.desirablegolf.co.uk',
    headerTextColor: '#090a11',
    accentColor: '#232743',
    headingFont: 'barlow' as const,
    squareButtons: true,
  },
};

/** Fixed demo tokens so the README can link straight to the customer pages. */
export const DEMO_TRACKING_TOKEN = 'demo-track-james-wilson-cos1048-xxxxxxxx';
export const DEMO_QUOTE_TOKEN = 'demo-quote-emily-clarke-q1001-xxxxxxxxxx';

const DAY = 86_400_000;

/**
 * Demo data for Desirable Golf (based on the approved prototype) plus a second,
 * isolated organisation to demonstrate tenancy. Timestamps are relative to `now`
 * so the attention engine always has something to show.
 */
export async function seedDemo(db: DB, now = new Date()) {
  const existing = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf')).limit(1);
  if (existing.length) return { skipped: true as const };

  const at = (daysAgo: number, hh = 10, mm = 0) => {
    const d = new Date(now.getTime() - daysAgo * DAY);
    d.setUTCHours(hh - 1, mm, 0, 0); // ~BST
    return d;
  };
  const today = now.toISOString().slice(0, 10);
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const [org] = await db
    .insert(organisations)
    .values({
      name: 'Desirable Golf',
      slug: 'desirable-golf',
      storeName: 'Desirable Golf',
      replyToEmail: 'orders@desirablegolf.co.uk',
      collectionLocation: 'Desirable Golf — Wheatley Golf Club, Doncaster',
      brandColor: DESIRABLE_GOLF_BRAND.brandColor,
      brandTheme: DESIRABLE_GOLF_BRAND.brandTheme,
      quoteTerms:
        'Custom-built equipment is made to your specification and cannot be returned unless faulty. A deposit is required to place the order; the balance is payable on collection.',
      plan: 'trial',
      trialEndsAt: new Date(now.getTime() + 30 * DAY),
      nextOrderNumber: 1052,
      nextQuoteNumber: 1002,
    })
    .returning();

  const [aaron, chris, will] = await db
    .insert(users)
    .values([
      { organisationId: org.id, name: 'Aaron Hodkin', email: 'aaron@desirablegolf.test', role: 'admin', passwordHash },
      { organisationId: org.id, name: 'Chris Long', email: 'chris@desirablegolf.test', role: 'manager', passwordHash },
      { organisationId: org.id, name: 'Will Walker', email: 'will@desirablegolf.test', role: 'staff', passwordHash },
    ])
    .returning();

  await seedCatalog(db, org.id);

  const store = {
    storeName: org.storeName, replyToEmail: org.replyToEmail, collectionLocation: org.collectionLocation,
    storePhone: org.storePhone, openingHours: org.openingHours, brandColor: org.brandColor, brandTheme: org.brandTheme,
  };

  type Ev = { type: string; daysAgo: number; hh: number; mm: number; actor: typeof aaron | 'system'; oldV?: unknown; newV?: unknown; meta?: unknown };

  async function makeOrder(o: {
    number: string; customer: { name: string; email: string; phone: string }; brand: string; product: string; sku: string; spec: string;
    totalPence: number; depositPence: number; eta: string | null; status: OrderStatus; takenBy: typeof aaron;
    createdDaysAgo: number; hh: number; mm: number; supplierRef: string; notes?: string; etaReason?: string;
    readyDaysAgo?: number; collectedDaysAgo?: number; extraPayments?: number; events: Ev[]; emails: EmailAutomationKey[];
  }) {
    const [c] = await db.insert(customers).values({ organisationId: org.id, ...o.customer, createdAt: at(o.createdDaysAgo, o.hh, o.mm) }).returning();
    const [row] = await db
      .insert(orders)
      .values({
        organisationId: org.id, orderNumber: o.number, customerId: c.id, status: o.status, brand: o.brand, product: o.product,
        sku: o.sku, supplier: o.brand, specificationText: o.spec, totalGrossPence: o.totalPence, etaDate: o.eta,
        etaReason: o.etaReason ?? '', supplierReference: o.supplierRef, internalNotes: o.notes ?? '', takenByUserId: o.takenBy.id,
        createdAt: at(o.createdDaysAgo, o.hh, o.mm),
        readyAt: o.readyDaysAgo !== undefined ? at(o.readyDaysAgo, 12, 21) : null,
        collectedAt: o.collectedDaysAgo !== undefined ? at(o.collectedDaysAgo, 9, 12) : null,
      })
      .returning();
    const ev = (e: Ev) =>
      db.insert(auditEvents).values({
        organisationId: org.id, entityType: 'order', entityId: row.id, orderId: row.id, customerId: c.id,
        actorType: e.actor === 'system' ? 'system' : 'user', actorUserId: e.actor === 'system' ? null : e.actor.id,
        actorLabel: e.actor === 'system' ? 'COS' : e.actor.name, eventType: e.type,
        oldValueJson: (e.oldV ?? null) as object, newValueJson: (e.newV ?? null) as object, metadataJson: (e.meta ?? null) as object,
        createdAt: at(e.daysAgo, e.hh, e.mm),
      });
    await ev({ type: 'order_created', daysAgo: o.createdDaysAgo, hh: o.hh, mm: o.mm, actor: o.takenBy, newV: { orderNumber: o.number, brand: o.brand, product: o.product, totalGrossPence: o.totalPence } });
    if (o.depositPence) {
      await db.insert(payments).values({ organisationId: org.id, orderId: row.id, kind: 'deposit', amountPence: o.depositPence, method: 'card', recordedByUserId: o.takenBy.id, createdAt: at(o.createdDaysAgo, o.hh, o.mm + 1) });
      await ev({ type: 'payment_recorded', daysAgo: o.createdDaysAgo, hh: o.hh, mm: o.mm + 1, actor: o.takenBy, newV: { kind: 'deposit', amountPence: o.depositPence, method: 'card', reference: '' } });
    }
    if (o.extraPayments) {
      await db.insert(payments).values({ organisationId: org.id, orderId: row.id, kind: 'payment', amountPence: o.extraPayments, method: 'card', recordedByUserId: aaron.id, createdAt: at(o.collectedDaysAgo ?? 0, 9, 10) });
      await ev({ type: 'payment_recorded', daysAgo: o.collectedDaysAgo ?? 0, hh: 9, mm: 10, actor: aaron, newV: { kind: 'payment', amountPence: o.extraPayments, method: 'card', reference: '' } });
    }
    for (const e of o.events) await ev(e);
    const paid = o.depositPence + (o.extraPayments ?? 0);
    for (const [i, template] of o.emails.entries()) {
      const daysAgo = template === 'order_confirmation' ? o.createdDaysAgo : template === 'ready_for_collection' ? (o.readyDaysAgo ?? 0) : o.createdDaysAgo - 1;
      const r = renderEmail(template, {
        store, customerName: c.name, reference: o.number, brand: o.brand, product: o.product, specification: o.spec,
        totalPence: o.totalPence, paidPence: paid, balancePence: o.totalPence - paid, etaDate: o.eta, etaReason: o.etaReason,
      });
      const [m] = await db
        .insert(messages)
        .values({
          organisationId: org.id, orderId: row.id, customerId: c.id, templateType: template, recipient: c.email, subject: r.subject,
          bodyHtml: r.html, bodyText: r.text, status: 'delivered', simulated: true, providerMessageId: `seed-${o.number}-${i}`,
          createdAt: at(daysAgo, o.hh, o.mm + 2), sentAt: at(daysAgo, o.hh, o.mm + 2), deliveredAt: at(daysAgo, o.hh, o.mm + 3),
        })
        .returning();
      await ev({ type: 'email_queued', daysAgo, hh: o.hh, mm: o.mm + 2, actor: o.takenBy, meta: { template, recipient: c.email, messageId: m.id } });
      await ev({ type: 'email_sent', daysAgo, hh: o.hh, mm: o.mm + 2, actor: 'system', meta: { template, recipient: c.email, messageId: m.id, simulated: true } });
      await ev({ type: 'email_delivered', daysAgo, hh: o.hh, mm: o.mm + 3, actor: 'system', meta: { template, messageId: m.id } });
    }
    return row;
  }

  const james = await makeOrder({
    number: 'COS-1048', customer: { name: 'James Wilson', email: 'james@example.com', phone: '07700 900111' },
    brand: 'PING', product: 'G440 MAX Driver', sku: 'PING-G440-MAX', spec: '10.5° / Alta CB Blue 50 Stiff / Golf Pride MCC +4',
    totalPence: 52900, depositPence: 10000, eta: addDays(today, 7), status: 'ordered', takenBy: aaron, createdDaysAgo: 2, hh: 15, mm: 42,
    supplierRef: 'PING-48192',
    events: [
      { type: 'status_changed', daysAgo: 2, hh: 15, mm: 44, actor: aaron, oldV: { status: 'place_order' }, newV: { status: 'ordered' } },
      { type: 'supplier_reference_changed', daysAgo: 2, hh: 15, mm: 44, actor: aaron, oldV: { supplierReference: '' }, newV: { supplierReference: 'PING-48192' } },
    ],
    emails: ['order_confirmation'],
  });
  await db.insert(trackingTokens).values({ organisationId: org.id, orderId: james.id, tokenHash: hashToken(DEMO_TRACKING_TOKEN), expiresAt: new Date(now.getTime() + 365 * DAY) });

  await makeOrder({
    number: 'COS-1047', customer: { name: 'Sarah Thompson', email: 'sarah@example.com', phone: '07700 900112' },
    brand: 'Callaway', product: 'Apex Ai200 Irons', sku: 'CW-APEX-AI200', spec: '5–PW / Recoil Dart 75 F3 / 1° upright',
    totalPence: 99900, depositPence: 25000, eta: addDays(today, 1), status: 'ready', takenBy: chris, createdDaysAgo: 6, hh: 10, mm: 18,
    supplierRef: 'CW-77521', readyDaysAgo: 2,
    events: [
      { type: 'status_changed', daysAgo: 6, hh: 10, mm: 21, actor: chris, oldV: { status: 'place_order' }, newV: { status: 'ordered' } },
      { type: 'order_ready', daysAgo: 2, hh: 12, mm: 21, actor: chris, oldV: { status: 'ordered' }, newV: { status: 'ready' } },
    ],
    emails: ['order_confirmation', 'ready_for_collection'],
  });

  await makeOrder({
    number: 'COS-1046', customer: { name: 'Oliver Green', email: 'oliver@example.com', phone: '07700 900113' },
    brand: 'TaylorMade', product: 'Qi4D Fairway Wood', sku: 'TM-QI4D-3W', spec: '15° / Ventus Blue Regular / Standard grip',
    totalPence: 29900, depositPence: 0, eta: addDays(today, 13), status: 'delayed', takenBy: will, createdDaysAgo: 5, hh: 9, mm: 7,
    supplierRef: 'TM-99217', notes: 'Supplier advised revised ETA', etaReason: 'TaylorMade have told us the shaft is on back order.',
    events: [
      { type: 'status_changed', daysAgo: 5, hh: 9, mm: 11, actor: will, oldV: { status: 'place_order' }, newV: { status: 'ordered' } },
      { type: 'status_changed', daysAgo: 2, hh: 8, mm: 31, actor: aaron, oldV: { status: 'ordered' }, newV: { status: 'delayed' } },
      { type: 'eta_changed', daysAgo: 2, hh: 8, mm: 31, actor: aaron, oldV: { etaDate: addDays(today, 3) }, newV: { etaDate: addDays(today, 13), etaReason: 'TaylorMade have told us the shaft is on back order.' } },
    ],
    emails: ['order_confirmation', 'eta_revised'],
  });

  await makeOrder({
    number: 'COS-1044', customer: { name: 'Daniel Harris', email: 'daniel@example.com', phone: '07700 900115' },
    brand: 'FootJoy', product: 'Premiere Series Shoes', sku: 'FJ-PRM', spec: 'UK 10 / White / Wide fit',
    totalPence: 18900, depositPence: 18900, eta: today, status: 'collected', takenBy: chris, createdDaysAgo: 10, hh: 11, mm: 34,
    supplierRef: 'FJ-11842', readyDaysAgo: 3, collectedDaysAgo: 2,
    events: [
      { type: 'status_changed', daysAgo: 10, hh: 11, mm: 39, actor: chris, oldV: { status: 'place_order' }, newV: { status: 'ordered' } },
      { type: 'order_ready', daysAgo: 3, hh: 14, mm: 5, actor: chris, oldV: { status: 'ordered' }, newV: { status: 'ready' } },
      { type: 'order_collected', daysAgo: 2, hh: 9, mm: 12, actor: aaron, oldV: { status: 'ready' }, newV: { status: 'collected' }, meta: { balanceOutstandingPence: 0 } },
    ],
    emails: ['order_confirmation', 'ready_for_collection'],
  });

  // Attention-engine examples
  await makeOrder({
    number: 'COS-1049', customer: { name: 'Lucy Patel', email: 'lucy@example.com', phone: '07700 900116' },
    brand: 'Scotty Cameron', product: 'Phantom 7.5 Putter', sku: 'SC-PH75', spec: '34" / 3° loft / Standard lie / Pistolero grip',
    totalPence: 49900, depositPence: 10000, eta: addDays(today, 12), status: 'place_order', takenBy: will, createdDaysAgo: 3, hh: 16, mm: 5,
    supplierRef: '', notes: 'Customer happy to wait for the black finish.', events: [], emails: ['order_confirmation'],
  });
  await makeOrder({
    number: 'COS-1050', customer: { name: 'Tom Baker', email: 'tom@example.com', phone: '07700 900117' },
    brand: 'Titleist', product: 'Vokey SM10 Wedges', sku: 'TT-SM10', spec: '50.12F / 56.10S / Dynamic Gold S200 / Std lie',
    totalPence: 39800, depositPence: 5000, eta: addDays(today, -1), status: 'ordered', takenBy: aaron, createdDaysAgo: 9, hh: 13, mm: 30,
    supplierRef: 'TT-55120',
    events: [{ type: 'status_changed', daysAgo: 9, hh: 13, mm: 40, actor: aaron, oldV: { status: 'place_order' }, newV: { status: 'ordered' } }],
    emails: ['order_confirmation'],
  });
  await makeOrder({
    number: 'COS-1051', customer: { name: 'Ryan Cooper', email: 'ryan@example.com', phone: '07700 900118' },
    brand: 'Mizuno', product: 'Pro 245 Irons', sku: 'MZ-PRO245', spec: '4–PW / KBS Tour 120 Stiff / 0.5" long / Midsize grips',
    totalPence: 129900, depositPence: 30000, eta: addDays(today, -9), status: 'ready', takenBy: chris, createdDaysAgo: 24, hh: 10, mm: 2,
    supplierRef: 'MZ-30418', readyDaysAgo: 9,
    events: [
      { type: 'status_changed', daysAgo: 24, hh: 10, mm: 10, actor: chris, oldV: { status: 'place_order' }, newV: { status: 'ordered' } },
      { type: 'order_ready', daysAgo: 9, hh: 12, mm: 21, actor: chris, oldV: { status: 'ordered' }, newV: { status: 'ready' } },
    ],
    emails: ['order_confirmation', 'ready_for_collection'],
  });

  // Open quote awaiting approval (prototype's Emily Clarke)
  const [emily] = await db
    .insert(customers)
    .values({ organisationId: org.id, name: 'Emily Clarke', email: 'emily@example.com', phone: '07700 900114', createdAt: at(3, 16, 26) })
    .returning();
  const [quote] = await db
    .insert(quotes)
    .values({
      organisationId: org.id, quoteNumber: 'Q-1001', customerId: emily.id, brand: 'Titleist', product: 'T250 Iron Set', sku: 'TT-T250',
      specificationText: '5–PW / AMT Black S300 / Standard lie', totalGrossPence: 119900, depositRequiredPence: 20000,
      estimatedLeadTime: '2–3 weeks', validUntil: addDays(today, 14), internalNotes: 'Awaiting customer approval',
      status: 'sent', tokenHash: hashToken(DEMO_QUOTE_TOKEN), createdByUserId: aaron.id, createdAt: at(3, 16, 26), sentAt: at(3, 16, 27),
    })
    .returning();
  await db.insert(auditEvents).values([
    { organisationId: org.id, entityType: 'quote', entityId: quote.id, quoteId: quote.id, customerId: emily.id, actorType: 'user', actorUserId: aaron.id, actorLabel: aaron.name, eventType: 'quote_created', createdAt: at(3, 16, 26) },
    { organisationId: org.id, entityType: 'quote', entityId: quote.id, quoteId: quote.id, customerId: emily.id, actorType: 'user', actorUserId: aaron.id, actorLabel: aaron.name, eventType: 'quote_sent', createdAt: at(3, 16, 27) },
  ]);

  // A second retailer — never visible to Desirable Golf staff.
  const [other] = await db
    .insert(organisations)
    .values({ name: 'Fairway Pro Shop', slug: 'fairway-demo', storeName: 'Fairway Pro Shop', replyToEmail: 'shop@fairway.test', plan: 'core', nextOrderNumber: 2002 })
    .returning();
  const [owner] = await db
    .insert(users)
    .values({ organisationId: other.id, name: 'Alex Morgan', email: 'alex@fairway.test', role: 'admin', passwordHash })
    .returning();
  const [oc] = await db.insert(customers).values({ organisationId: other.id, name: 'Priya Shah', email: 'priya@example.com' }).returning();
  await db.insert(orders).values({
    organisationId: other.id, orderNumber: 'COS-2001', customerId: oc.id, brand: 'Cobra', product: 'DS-Adapt Driver',
    specificationText: '9° / Stiff', totalGrossPence: 44900, takenByUserId: owner.id,
  });

  return { skipped: false as const, orgId: org.id };
}

/** Demo Custom Fitting catalogue. Prices are illustrative RRPs in pence. */
export async function seedCatalog(db: DB, organisationId: string) {
  const b = await db
    .insert(brands)
    .values([
      { organisationId, name: 'PING', tagline: 'Precision-engineered fitting', sortOrder: 1 },
      { organisationId, name: 'TaylorMade', tagline: 'Performance for every player', sortOrder: 2 },
      { organisationId, name: 'Callaway', tagline: 'Innovation for distance', sortOrder: 3 },
      { organisationId, name: 'Titleist', tagline: 'Tour-proven craftsmanship', sortOrder: 4 },
    ])
    .returning();
  const id = (name: string) => b.find((x) => x.name === name)!.id;
  const m = (brand: string, name: string, category: string, price: number, lead: number, sku = '') => ({
    organisationId, brandId: id(brand), name, category, basePricePence: price * 100, leadTimeDays: lead, sku, season: '2026',
  });
  await db.insert(productModels).values([
    m('PING', 'G440 MAX Driver', 'driver', 529, 10, 'PING-G440-MAX'),
    m('PING', 'G440 LST Driver', 'driver', 529, 10, 'PING-G440-LST'),
    m('PING', 'G440 SFT Driver', 'driver', 529, 10, 'PING-G440-SFT'),
    m('PING', 'G430 MAX 10K Driver', 'driver', 499, 7, 'PING-G430-10K'),
    m('PING', 'G440 MAX Fairway', 'fairway', 339, 10),
    m('PING', 'i530 Irons (5–PW)', 'irons', 1099, 14, 'PING-I530'),
    m('PING', 'PLD Anser Putter', 'putter', 379, 21),
    m('TaylorMade', 'Qi4D Driver', 'driver', 549, 10, 'TM-QI4D-DR'),
    m('TaylorMade', 'Qi4D Fairway Wood', 'fairway', 299, 10, 'TM-QI4D-3W'),
    m('TaylorMade', 'Qi4D Rescue', 'hybrid', 249, 10),
    m('Callaway', 'Elyte Driver', 'driver', 549, 10),
    m('Callaway', 'Apex Ai200 Irons (5–PW)', 'irons', 999, 14, 'CW-APEX-AI200'),
    m('Titleist', 'GT2 Driver', 'driver', 549, 10),
    m('Titleist', 'T250 Irons (5–PW)', 'irons', 1199, 18, 'TT-T250'),
    m('Titleist', 'Vokey SM10 Wedge', 'wedge', 199, 10, 'TT-SM10'),
  ]);
  const cats = await db
    .insert(componentCategories)
    .values([
      { organisationId, key: 'shaft', label: 'Shaft', sortOrder: 1 },
      { organisationId, key: 'grip', label: 'Grip', sortOrder: 2 },
      { organisationId, key: 'ball', label: 'Ball', sortOrder: 3 },
    ])
    .returning();
  const cat = (key: string) => cats.find((c) => c.key === key)!.id;
  const WOODS = { clubCategories: ['driver', 'fairway', 'hybrid'] };
  const IRONS = { clubCategories: ['irons', 'wedge'] };
  const c = (category: string, name: string, price: number, metadata: object = {}, lead = 0) => ({
    organisationId, categoryId: cat(category), name, value: name, upchargePence: price * 100, metadata, leadTimeDays: lead || null,
  });
  await db.insert(components).values([
    c('shaft', 'Fujikura Ventus Blue 6S', 350, WOODS, 14),
    c('shaft', 'Mitsubishi Tensei 1K Pro White', 300, WOODS, 14),
    c('shaft', 'Project X HZRDUS Black', 280, WOODS, 14),
    c('shaft', 'ACCRA TZ6 M4', 320, WOODS, 21),
    c('shaft', 'Stock shaft (no upcharge)', 0, WOODS),
    c('shaft', 'KBS Tour Lite (stock)', 0, IRONS),
    c('shaft', 'True Temper Dynamic Gold S300', 0, IRONS),
    c('shaft', 'Nippon N.S. Pro Modus³ 105', 15, IRONS),
    c('grip', 'Golf Pride Tour Velvet', 0),
    c('grip', 'Golf Pride MCC', 10),
    c('grip', 'Lamkin Crossline', 8),
    c('grip', 'SuperStroke Zenergy', 12, { clubCategories: ['putter'] }),
    c('ball', 'Titleist Pro V1 (dozen)', 52),
    c('ball', 'Titleist Pro V1x (dozen)', 52),
    c('ball', 'Callaway Chrome Soft (dozen)', 45),
    c('ball', 'TaylorMade TP5 (dozen)', 45),
  ]);
}
