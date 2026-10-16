/**
 * COS database schema.
 *
 * Conventions
 * - Every business table carries `organisation_id`; isolation is enforced in the
 *   data layer (withTenant) AND by Postgres row-level security (see drizzle/0001_security.sql).
 * - Money is stored as integer pence (`*_pence`) to avoid floating point drift.
 * - Nothing is hard-deleted by the app: rows are archived (`archived_at`).
 * - `audit_events` and `payments` are append-only (DB triggers reject UPDATE/DELETE).
 * - `orders.taken_by_user_id` / `orders.created_at` are immutable (DB trigger).
 */
import { sql } from 'drizzle-orm';
import type { BrandTheme } from '../lib/branding';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const orgId = () => uuid('organisation_id').notNull().references(() => organisations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export type EmailAutomationKey =
  | 'order_confirmation'
  | 'quote_approval'
  | 'eta_revised'
  | 'ready_for_collection'
  | 'collection_reminder';

export type EmailAutomations = Record<EmailAutomationKey, boolean>;

/* ─────────────────────────── Tenancy & identity ─────────────────────────── */

export const organisations = pgTable('organisations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Customer-facing identity (emails, quote approval and tracking pages)
  storeName: text('store_name').notNull(),
  replyToEmail: text('reply_to_email').notNull(),
  /** Optional "From" address on the retailer's own domain (e.g. orders@shop.co.uk). Used only once
   *  its domain is verified in COS's Resend account; otherwise mail goes from the COS platform domain. */
  senderEmail: text('sender_email').notNull().default(''),
  senderVerifiedAt: timestamp('sender_verified_at', { withTimezone: true }),
  collectionLocation: text('collection_location').notNull().default(''),
  storePhone: text('store_phone').notNull().default(''),
  openingHours: text('opening_hours').notNull().default(''),
  brandColor: text('brand_color').notNull().default('#193b2c'),
  /** Logo, colours and fonts for customer emails and pages (see src/lib/branding.ts). */
  brandTheme: jsonb('brand_theme').$type<BrandTheme>().notNull().default({}),
  quoteTerms: text('quote_terms').notNull().default(''),
  timezone: text('timezone').notNull().default('Europe/London'),
  // SaaS
  plan: text('plan', { enum: ['trial', 'core', 'pro'] }).notNull().default('trial'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  // Automations & attention engine thresholds
  emailAutomations: jsonb('email_automations').$type<EmailAutomations>().notNull().default({
    order_confirmation: true,
    quote_approval: true,
    eta_revised: true,
    ready_for_collection: true,
    collection_reminder: true,
  }),
  /** Off = payments are taken at the shop's till: no Payments section, no balance check at collection. */
  paymentTracking: boolean('payment_tracking').notNull().default(true),
  /** Monthly performance email: on/off, who gets it (empty = the owner/admins), last month sent (YYYY-MM). */
  performanceReport: jsonb('performance_report').$type<PerformanceReportSettings>().notNull().default({ enabled: true, recipients: [] }),
  /** Golf ball printing: one-off artwork setup charge added to each print quote. */
  ballSetupFeePence: integer('ball_setup_fee_pence').notNull().default(0),
  readyUncollectedDays: integer('ready_uncollected_days').notNull().default(7),
  quoteFollowupDays: integer('quote_followup_days').notNull().default(5),
  missingSupplierRefDays: integer('missing_supplier_ref_days').notNull().default(2),
  // Per-organisation human-friendly numbering
  nextOrderNumber: integer('next_order_number').notNull().default(1001),
  nextQuoteNumber: integer('next_quote_number').notNull().default(1001),
  orderPrefix: text('order_prefix').notNull().default('COS'),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    organisationId: orgId(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'manager', 'staff'] }).notNull().default('staff'),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    /** False for team members who only pick their name on a shared shop login. */
    loginEnabled: boolean('login_enabled').notNull().default(true),
    /** A shared counter login (e.g. "Pro Shop"): asks who's working, then acts as that member. */
    sharedLogin: boolean('shared_login').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    notificationsSeenAt: timestamp('notifications_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`), index('users_org_idx').on(t.organisationId)],
);

/** Server-side sessions. Only the SHA-256 of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id),
    organisationId: orgId(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time password reset links. Only the SHA-256 of the emailed token is stored. Owner-role access only. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id),
    organisationId: orgId(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId, t.createdAt)],
);

/* ─────────────────────────────── Customers ──────────────────────────────── */

export const customers = pgTable(
  'customers',
  {
    id: id(),
    organisationId: orgId(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    // Imported customers may have no email yet; only real addresses must be unique.
    uniqueIndex('customers_org_email_unique').on(t.organisationId, sql`lower(${t.email})`).where(sql`${t.email} <> ''`),
    index('customers_org_name_idx').on(t.organisationId, t.name),
  ],
);

/* ──────────────────────────────── Quotes ────────────────────────────────── */

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    organisationId: orgId(),
    quoteNumber: text('quote_number').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    brand: text('brand').notNull(),
    product: text('product').notNull(),
    sku: text('sku').notNull().default(''),
    specificationText: text('specification_text').notNull(),
    /** Structured build (Phase 2 — COS Configure). Null for free-text specs. */
    specificationJson: jsonb('specification_json'),
    totalGrossPence: integer('total_gross_pence').notNull(),
    depositRequiredPence: integer('deposit_required_pence').notNull().default(0),
    estimatedLeadTime: text('estimated_lead_time').notNull().default(''),
    validUntil: date('valid_until', { mode: 'string' }),
    internalNotes: text('internal_notes').notNull().default(''),
    status: text('status', { enum: QUOTE_STATUSES }).notNull().default('draft'),
    /** SHA-256 of the current approval token. Rotated whenever the link is re-issued. */
    tokenHash: text('token_hash').unique(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedName: text('accepted_name'),
    convertedOrderId: uuid('converted_order_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('quotes_org_number_unique').on(t.organisationId, t.quoteNumber),
    index('quotes_org_status_idx').on(t.organisationId, t.status),
    index('quotes_customer_idx').on(t.customerId),
  ],
);

/* ──────────────────────────────── Orders ────────────────────────────────── */

export const ORDER_STATUSES = ['place_order', 'ordered', 'delayed', 'ready', 'collected'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orders = pgTable(
  'orders',
  {
    id: id(),
    organisationId: orgId(),
    orderNumber: text('order_number').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    quoteId: uuid('quote_id').references(() => quotes.id),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('place_order'),
    brand: text('brand').notNull(),
    product: text('product').notNull(),
    sku: text('sku').notNull().default(''),
    specificationText: text('specification_text').notNull(),
    specificationJson: jsonb('specification_json'),
    totalGrossPence: integer('total_gross_pence').notNull(),
    etaDate: date('eta_date', { mode: 'string' }),
    /** Customer-facing explanation for the most recent ETA change / delay. */
    etaReason: text('eta_reason').notNull().default(''),
    supplier: text('supplier').notNull().default(''),
    supplierReference: text('supplier_reference').notNull().default(''),
    supplierNotes: text('supplier_notes').notNull().default(''),
    internalNotes: text('internal_notes').notNull().default(''),
    /** Permanent: the authenticated staff member who took the order. */
    takenByUserId: uuid('taken_by_user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('orders_org_number_unique').on(t.organisationId, t.orderNumber),
    index('orders_org_status_idx').on(t.organisationId, t.status),
    index('orders_customer_idx').on(t.customerId),
  ],
);

/* ─────────────────────────────── Payments ───────────────────────────────── */

/** `credit` = customer account credit from the till, applied against the order. */
export const PAYMENT_KINDS = ['deposit', 'payment', 'credit', 'refund'] as const;

export const PAYMENT_KIND_LABELS: Record<(typeof PAYMENT_KINDS)[number], string> = {
  deposit: 'Deposit',
  payment: 'Payment',
  credit: 'Account credit',
  refund: 'Refund',
};
export const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'voucher', 'account', 'other'] as const;

/** Append-only. Corrections are recorded as a `refund` entry, never by editing. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    kind: text('kind', { enum: PAYMENT_KINDS }).notNull(),
    amountPence: integer('amount_pence').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference').notNull().default(''),
    recordedByUserId: uuid('recorded_by_user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('payments_order_idx').on(t.orderId)],
);

/* ──────────────────────── Audit ledger (COS Ledger) ─────────────────────── */

export const ACTOR_TYPES = ['user', 'system', 'customer'] as const;

/**
 * Append-only ledger of every meaningful action. Generalises the recommended
 * `order_events` table so quotes, customers and settings share one ledger.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organisationId: orgId(),
    entityType: text('entity_type', {
      enum: ['order', 'quote', 'customer', 'organisation', 'user', 'message', 'backup'],
    }).notNull(),
    entityId: uuid('entity_id'),
    orderId: uuid('order_id'),
    quoteId: uuid('quote_id'),
    customerId: uuid('customer_id'),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: uuid('actor_user_id'),
    /** Snapshot of the actor's display name at the time of the event. */
    actorLabel: text('actor_label').notNull(),
    eventType: text('event_type').notNull(),
    oldValueJson: jsonb('old_value_json'),
    newValueJson: jsonb('new_value_json'),
    metadataJson: jsonb('metadata_json'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_order_idx').on(t.orderId, t.createdAt),
    index('audit_quote_idx').on(t.quoteId, t.createdAt),
    index('audit_org_created_idx').on(t.organisationId, t.createdAt),
  ],
);

/* ─────────────────────────────── Messages ───────────────────────────────── */

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'bounced', 'suppressed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = pgTable(
  'messages',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid('order_id').references(() => orders.id),
    quoteId: uuid('quote_id').references(() => quotes.id),
    customerId: uuid('customer_id').references(() => customers.id),
    templateType: text('template_type').$type<EmailAutomationKey>().notNull(),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    providerMessageId: text('provider_message_id'),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull().default('queued'),
    error: text('error'),
    simulated: boolean('simulated').notNull().default(false),
    sentByUserId: uuid('sent_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    index('messages_order_idx').on(t.orderId),
    index('messages_provider_idx').on(t.providerMessageId),
    index('messages_org_created_idx').on(t.organisationId, t.createdAt),
  ],
);

/* ────────────────────────────── Attachments ─────────────────────────────── */

export const ATTACHMENT_CATEGORIES = [
  'supplier_confirmation',
  'fitting_sheet',
  'screenshot',
  'invoice',
  'product_photo',
  'other',
] as const;

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    category: text('category', { enum: ATTACHMENT_CATEGORIES }).notNull().default('other'),
    visibility: text('visibility', { enum: ['internal', 'customer-visible'] }).notNull().default('internal'),
    uploadedByUserId: uuid('uploaded_by_user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('attachments_order_idx').on(t.orderId)],
);

/* ──────────────────────────── Tracking tokens ───────────────────────────── */

export const trackingTokens = pgTable(
  'tracking_tokens',
  {
    id: id(),
    organisationId: orgId(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('tracking_order_idx').on(t.orderId)],
);

/* ──────────────────────────── Backups / export ──────────────────────────── */

export const BACKUP_PROVIDERS = ['cos_hosted', 'google_drive', 'dropbox'] as const;
export type BackupProvider = (typeof BACKUP_PROVIDERS)[number];

export const backupDestinations = pgTable(
  'backup_destinations',
  {
    id: id(),
    organisationId: orgId(),
    provider: text('provider', { enum: BACKUP_PROVIDERS }).notNull(),
    status: text('status', { enum: ['active', 'pending_auth', 'disabled'] }).notNull().default('active'),
    /** Provider-specific settings, e.g. target folder id. */
    config: jsonb('config').notNull().default({}),
    /** OAuth refresh token etc., encrypted with AUTH_SECRET-derived key. Never sent to the browser. */
    credentialsEncrypted: text('credentials_encrypted'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('backup_dest_org_provider_unique').on(t.organisationId, t.provider)],
);

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: id(),
    organisationId: orgId(),
    provider: text('provider', { enum: BACKUP_PROVIDERS }).notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull().default('running'),
    storageKey: text('storage_key'),
    sizeBytes: integer('size_bytes'),
    error: text('error'),
    triggeredByUserId: uuid('triggered_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backup_runs_org_idx').on(t.organisationId, t.startedAt)],
);

/* ───────────────────── Phase 2 — COS Configure (schema only) ───────────────────── */

export const brands = pgTable('brands', {
  id: id(),
  organisationId: orgId(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** A head/model for a season, e.g. PING G440 MAX Driver (2026). */
export const productModels = pgTable('product_models', {
  id: id(),
  organisationId: orgId(),
  brandId: uuid('brand_id').notNull().references(() => brands.id),
  name: text('name').notNull(),
  sku: text('sku').notNull().default(''),
  category: text('category').notNull(), // driver, fairway, hybrid, irons, wedge, putter, ...
  season: text('season').notNull().default(''),
  basePricePence: integer('base_price_pence').notNull(),
  /** Iron sets: clubs included in the base price (per-club upcharges multiply by the chosen set's size). Null = a single club. */
  clubsInSet: integer('clubs_in_set'),
  leadTimeDays: integer('lead_time_days'),
  imageKey: text('image_key'),
  validFrom: date('valid_from', { mode: 'string' }),
  validTo: date('valid_to', { mode: 'string' }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** A golf ball the shop offers for logo/text printing, priced per dozen including printing. */
export const printBalls = pgTable('print_balls', {
  id: id(),
  organisationId: orgId(),
  brand: text('brand').notNull(),
  name: text('name').notNull(),
  /** Ball colour used for the rendered preview, e.g. #ffffff or #f4e21b. */
  colour: text('colour').notNull().default('#ffffff'),
  pricePerDozenPence: integer('price_per_dozen_pence').notNull(),
  /** Product photo of the ball (private storage). Its printed side is wrapped onto the 3D preview. */
  photoKey: text('photo_key'),
  photoMime: text('photo_mime'),
  minDozens: integer('min_dozens').notNull().default(1),
  leadTimeDays: integer('lead_time_days'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** head/model, loft, set_makeup, shaft, flex, length, lie, grip, grip_size, wraps … */
export const componentCategories = pgTable('component_categories', {
  id: id(),
  organisationId: orgId(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  required: boolean('required').notNull().default(false),
  allowMultiple: boolean('allow_multiple').notNull().default(false),
});

export const components = pgTable('components', {
  id: id(),
  organisationId: orgId(),
  categoryId: uuid('category_id').notNull().references(() => componentCategories.id),
  brandId: uuid('brand_id').references(() => brands.id),
  name: text('name').notNull(),
  value: text('value').notNull(),
  upchargePence: integer('upcharge_pence').notNull().default(0),
  leadTimeDays: integer('lead_time_days'),
  imageKey: text('image_key'),
  season: text('season').notNull().default(''),
  active: boolean('active').notNull().default(true),
  metadata: jsonb('metadata').notNull().default({}),
});

/** Which components are valid for a model, with optional conditions (e.g. lie range only with set X). */
export const modelComponentRules = pgTable('model_component_rules', {
  id: id(),
  organisationId: orgId(),
  modelId: uuid('model_id').notNull().references(() => productModels.id),
  componentId: uuid('component_id').notNull().references(() => components.id),
  rule: text('rule', { enum: ['allowed', 'excluded', 'default'] }).notNull().default('allowed'),
  upchargeOverridePence: integer('upcharge_override_pence'),
  conditions: jsonb('conditions').notNull().default({}),
});

export const configurationQuotes = pgTable('configuration_quotes', {
  id: id(),
  organisationId: orgId(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  modelId: uuid('model_id').notNull().references(() => productModels.id),
  summaryText: text('summary_text').notNull(),
  totalPence: integer('total_pence').notNull(),
  leadTimeDays: integer('lead_time_days'),
  createdAt: createdAt(),
});

export const configurationQuoteItems = pgTable('configuration_quote_items', {
  id: id(),
  organisationId: orgId(),
  configurationQuoteId: uuid('configuration_quote_id').notNull().references(() => configurationQuotes.id),
  categoryId: uuid('category_id').notNull().references(() => componentCategories.id),
  componentId: uuid('component_id').references(() => components.id),
  label: text('label').notNull(),
  value: text('value').notNull(),
  upchargePence: integer('upcharge_pence').notNull().default(0),
});

export type Organisation = typeof organisations.$inferSelect;
export type PerformanceReportSettings = { enabled: boolean; recipients: string[]; lastSentMonth?: string };
export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type PrintBall = typeof printBalls.$inferSelect;
export type ProductModel = typeof productModels.$inferSelect;
export type Component = typeof components.$inferSelect;
