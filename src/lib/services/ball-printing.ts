import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant, type DB } from '@/db';
import { organisations, printBalls, type Organisation } from '@/db/schema';
import { recordEvent } from '../audit';
import {
  INK_COLOURS,
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  MAX_PROOF_BYTES,
  PRINT_FONTS,
  sniffImage,
  STARTER_BALLS,
  type BallPrintSpec,
  type InkKey,
  type PrintFontKey,
} from '../ball-print';
import { money, parseMoneyToPence } from '../format';
import { storage } from '../storage';
import { newToken } from '../tokens';
import { customerFields, parse } from '../validation';
import { requireRole, ServiceError, type Ctx } from './common';
import { checkDesignLimits, customerDesignCtx, designSubmitted } from './online-designs';
import { createQuote } from './quotes';

export async function getBallRange(orgId: string, opts: { includeInactive?: boolean } = {}) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(printBalls)
      // Deleted balls never show; retired ones only on the range page.
      .where(and(isNull(printBalls.removedAt), opts.includeInactive ? undefined : eq(printBalls.active, true)))
      .orderBy(asc(printBalls.sortOrder), asc(printBalls.brand), asc(printBalls.name)),
  );
}

const pence = (label: string, min = 0) =>
  z.string().transform((v, c) => {
    const p = parseMoneyToPence(v || '0');
    if (p === null || p < min) {
      c.addIssue({ code: 'custom', message: `${label} must be an amount like 54.99` });
      return z.NEVER;
    }
    return p;
  });

const hex = z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Choose a colour').default('#ffffff');

const ballSchema = z.object({
  brand: z.string().trim().min(1, 'Brand is required').max(60),
  name: z.string().trim().min(1, 'Model is required').max(80),
  colour: hex,
  pricePerDozenPence: pence('Price per dozen', 1),
  minDozens: z.coerce.number().int().min(1).max(500).default(1),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(0),
});

async function auditCatalogue(ctx: Ctx, what: string, value: Record<string, unknown>) {
  await withTenant(ctx.org.id, (tx) =>
    recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation',
      entityId: ctx.org.id, newValue: value, metadata: { section: `ball_printing.${what}` },
    }),
  );
}

export async function addBall(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const v = parse(ballSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    v.brand = await existingBrandSpelling(tx, v.brand);
    await tx.insert(printBalls).values({ organisationId: ctx.org.id, ...v, leadTimeDays: v.leadTimeDays || null });
  });
  await auditCatalogue(ctx, 'ball_added', v);
}

/** "Taylormade" joins the existing "TaylorMade" rather than becoming a second brand. */
async function existingBrandSpelling(tx: DB, brand: string, exceptId?: string) {
  const [same] = await tx
    .select({ brand: printBalls.brand })
    .from(printBalls)
    .where(and(sql`lower(${printBalls.brand}) = ${brand.toLowerCase()}`, exceptId ? sql`${printBalls.id} <> ${exceptId}` : undefined))
    .limit(1);
  return same?.brand ?? brand;
}

/** Edit a ball's brand, model, colour, price, minimum and lead time. Quotes keep their own copy. */
export async function updateBall(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const v = parse(ballSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const [before] = await tx.select().from(printBalls).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))).limit(1);
    if (!before) throw new ServiceError('Ball not found.');
    v.brand = await existingBrandSpelling(tx, v.brand, id);
    const next = { ...v, leadTimeDays: v.leadTimeDays || null };
    await tx.update(printBalls).set(next).where(eq(printBalls.id, id));
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => before[k] !== next[k]);
    if (changed.length) {
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
        oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])), newValue: { id, ...Object.fromEntries(changed.map((k) => [k, next[k]])) },
        metadata: { section: 'ball_printing.ball_edited', ball: `${before.brand} ${before.name}` },
      });
    }
  });
}

export async function updateBallPrice(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const v = parse(z.object({ pricePerDozenPence: pence('Price per dozen', 1) }), raw);
  await withTenant(ctx.org.id, (tx) =>
    tx.update(printBalls).set(v).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))),
  );
  await auditCatalogue(ctx, 'ball_price_changed', { id, ...v });
}

/** Stores a product photo for a ball; the builder wraps its printed side onto the 3D ball. */
export async function setBallPhoto(ctx: Ctx, id: string, file: File | null) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const img = await readImage(file, 'photo', MAX_LOGO_BYTES);
  if (!img) throw new ServiceError('Choose a photo of the ball.', { photo: 'Required' });
  const [ball] = await withTenant(ctx.org.id, (tx) => tx.select().from(printBalls).where(eq(printBalls.id, id)).limit(1));
  if (!ball) throw new ServiceError('Ball not found.');
  const key = `orgs/${ctx.org.id}/ball-photos/${id}-${newToken().slice(0, 10)}.${LOGO_TYPES[img.mime]}`;
  await storage().put(key, img.buf, img.mime);
  await withTenant(ctx.org.id, (tx) => tx.update(printBalls).set({ photoKey: key, photoMime: img.mime }).where(eq(printBalls.id, id)));
  await auditCatalogue(ctx, 'ball_photo_set', { id, ball: `${ball.brand} ${ball.name}` });
}

/** Balls are retired, never deleted, so old quotes keep their references. */
export async function setBallActive(ctx: Ctx, id: string, active: boolean) {
  requireRole(ctx, 'manager', 'edit the ball range');
  await withTenant(ctx.org.id, (tx) =>
    tx.update(printBalls).set({ active }).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))),
  );
  await auditCatalogue(ctx, active ? 'ball_restored' : 'ball_retired', { id });
}

/** Deletes a ball from the range, or restores it. Nothing is erased: quotes keep their own copy. */
export async function setBallRemoved(ctx: Ctx, id: string, removed: boolean) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const ball = await withTenant(ctx.org.id, async (tx) => {
    const [b] = await tx.select().from(printBalls).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))).limit(1);
    if (!b) throw new ServiceError('Ball not found.');
    await tx.update(printBalls).set(removed ? { removedAt: new Date(), active: false } : { removedAt: null, active: true }).where(eq(printBalls.id, id));
    return b;
  });
  await auditCatalogue(ctx, removed ? 'ball_deleted' : 'ball_undeleted', { id, ball: `${ball.brand} ${ball.name}` });
}

export async function listRemovedBalls(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(printBalls).where(isNotNull(printBalls.removedAt)).orderBy(desc(printBalls.removedAt)));
}

export async function addStarterBalls(ctx: Ctx) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const existing = await getBallRange(ctx.org.id, { includeInactive: true });
  if (existing.length) throw new ServiceError('Your ball range already has balls in it.');
  await withTenant(ctx.org.id, (tx) =>
    tx.insert(printBalls).values(
      STARTER_BALLS.map((b, i) => ({
        organisationId: ctx.org.id, brand: b.brand, name: b.name, colour: b.colour, pricePerDozenPence: b.price, sortOrder: i,
      })),
    ),
  );
  await auditCatalogue(ctx, 'starter_range_added', { count: STARTER_BALLS.length });
}

export async function updateSetupFee(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'change ball printing prices');
  const v = parse(z.object({ ballSetupFeePence: pence('Setup fee') }), raw);
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set(v).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { ballSetupFeePence: ctx.org.ballSetupFeePence }, newValue: v, metadata: { section: 'ball_printing.setup_fee' },
    });
  });
}

/* ───────────────────────────── Print quotes ───────────────────────────── */

const fontKeys = PRINT_FONTS.map((f) => f.key) as [string, ...string[]];
const inkKeys = INK_COLOURS.map((c) => c.key) as [string, ...string[]];

const printSchema = z.object({
  ...customerFields,
  ballId: z.string().uuid('Choose a ball'),
  artworkType: z.enum(['logo', 'text'], { message: 'Add a logo or some text' }),
  textLines: z.array(z.string().trim().max(24, 'Keep each line to 24 characters')).max(3).default([]),
  font: z.enum(fontKeys).default('classic'),
  ink: z.enum(inkKeys).default('black'),
  scale: z.coerce.number().min(0.3).max(1).default(0.75),
  dozens: z.coerce.number().int('Whole dozens only').min(1, 'At least 1 dozen').max(500),
  pricePerDozenPence: pence('Price per dozen', 1),
  setupFeePence: pence('Setup fee'),
  notes: z.string().trim().max(2000).default(''),
  validUntil: z.string().trim().default(''),
});

export async function readImage(file: File | null, what: string, maxBytes: number) {
  if (!file || file.size === 0) return null;
  if (file.size > maxBytes) throw new ServiceError(`The ${what} must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImage(buf);
  if (!mime || !LOGO_TYPES[mime]) throw new ServiceError(`The ${what} must be a PNG, JPG or WebP image.`);
  return { buf, mime };
}

/**
 * Turns a ball design into a normal quote (so approval, conversion and audit are shared).
 * The customer's original logo and the rendered proof are kept in private storage and
 * referenced from `specification_json`; the approval email shows the proof.
 */
export async function createBallPrintQuote(
  ctx: Ctx,
  raw: unknown,
  files: { logo: File | null; proof: File | null },
  opts: { send: boolean; source?: 'staff' | 'customer' },
) {
  const fromCustomer = opts.source === 'customer';
  const input = parse(printSchema, raw);
  const [ball] = await withTenant(ctx.org.id, (tx) =>
    tx.select().from(printBalls).where(and(eq(printBalls.id, input.ballId), eq(printBalls.active, true))).limit(1),
  );
  if (!ball) throw new ServiceError('That ball is no longer in your range.', { ballId: 'Choose another ball' });
  if (input.dozens < ball.minDozens) {
    throw new ServiceError(`The ${ball.name} has a minimum of ${ball.minDozens} dozen.`, { dozens: `Minimum ${ball.minDozens}` });
  }
  // Customers designing online always get the shop's list price; staff can adjust it when reviewing.
  if (fromCustomer) {
    input.pricePerDozenPence = ball.pricePerDozenPence;
    input.setupFeePence = ctx.org.ballSetupFeePence;
    input.validUntil = '';
    input.customerId = null;
  }

  const lines = input.textLines.filter(Boolean);
  if (input.artworkType === 'text' && !lines.length) throw new ServiceError('Enter the text to print.', { textLines: 'Required' });
  const logo = input.artworkType === 'logo' ? await readImage(files.logo, 'logo', MAX_LOGO_BYTES) : null;
  if (input.artworkType === 'logo' && !logo) throw new ServiceError(fromCustomer ? 'Please upload your logo.' : 'Upload the customer’s logo.', { logo: 'Required' });
  const proof = await readImage(files.proof, 'preview', MAX_PROOF_BYTES);
  if (!proof) throw new ServiceError('The preview could not be created. Please try again.');

  const id = newToken().slice(0, 16);
  const base = `orgs/${ctx.org.id}/ball-printing/${id}`;
  const proofKey = `${base}-proof.${LOGO_TYPES[proof.mime]}`;
  await storage().put(proofKey, proof.buf, proof.mime);
  let artwork: BallPrintSpec['artwork'];
  if (logo) {
    const key = `${base}-logo.${LOGO_TYPES[logo.mime]}`;
    await storage().put(key, logo.buf, logo.mime);
    const filename = (files.logo!.name || 'logo').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    artwork = { type: 'logo', filename, mimeType: logo.mime, storageKey: key, scale: input.scale };
  } else {
    artwork = { type: 'text', lines, font: input.font as PrintFontKey, ink: input.ink as InkKey, scale: input.scale };
  }

  const total = input.dozens * input.pricePerDozenPence + input.setupFeePence;
  const fontLabel = PRINT_FONTS.find((f) => f.key === input.font)!.label;
  const inkLabel = INK_COLOURS.find((c) => c.key === input.ink)!.label;
  const specLines = [
    `Ball: ${ball.brand} ${ball.name}`,
    artwork.type === 'logo' ? `Personalisation: customer logo (${artwork.filename})` : `Personalisation: “${lines.join(' / ')}” — ${fontLabel}, ${inkLabel} ink`,
    `Quantity: ${input.dozens} dozen (${input.dozens * 12} balls) at ${money(input.pricePerDozenPence)} per dozen`,
    ...(input.setupFeePence ? [`Artwork setup: ${money(input.setupFeePence)}`] : []),
    ...(input.notes ? ['', input.notes] : []),
  ];
  const spec: BallPrintSpec = {
    kind: 'cos-ball-print',
    version: 1,
    ball: { id: ball.id, brand: ball.brand, name: ball.name, colour: ball.colour },
    artwork,
    proofKey,
    dozens: input.dozens,
    pricePerDozenPence: input.pricePerDozenPence,
    setupFeePence: input.setupFeePence,
    notes: input.notes,
    totalPence: total,
    ...(fromCustomer ? { submittedOnline: true } : {}),
  };
  const days = ball.leadTimeDays ?? 0;

  return createQuote(
    ctx,
    {
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
      customerId: input.customerId ?? '',
      brand: ball.brand,
      product: `${ball.name} (personalised)`,
      sku: '',
      specificationText: specLines.join('\n'),
      totalGrossPence: (total / 100).toFixed(2),
      depositRequiredPence: '0',
      estimatedLeadTime: days ? `About ${Math.ceil(days / 7)} week${days > 7 ? 's' : ''}` : '',
      validUntil: input.validUntil,
      internalNotes: fromCustomer
        ? 'Designed and submitted online by the customer. Check the artwork, then approve it in store to put it into print, or edit it and email a proof back.'
        : 'Created with Ball Printing.',
    },
    { send: opts.send, specificationJson: spec },
  );
}

/* ─────────────────────── Customer design link (/design/<slug>) ─────────────────────── */

export { DESIGN_LIMITS } from './online-designs';

/** The shop behind a public design link, if the link is switched on and there are balls to choose from. */
export async function findDesignShop(slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, slug)).limit(1);
  if (!org?.ballDesignLink) return null;
  const balls = await getBallRange(org.id);
  return balls.length ? { org, balls } : null;
}

export const designPathFor = (org: Pick<Organisation, 'slug'>) => `/design/${org.slug}`;
export const publicBallPhotoPath = (org: Pick<Organisation, 'slug'>, ballId: string, photoKey: string) =>
  `/api/public/ball-photo/${org.slug}/${ballId}?v=${photoKey.slice(-10)}`;

/**
 * A customer submits their own design. It becomes a draft quote at list price for the shop to
 * review (approve in store → into print, or edit and send a proof back). The customer gets a
 * "we've received it" email and the shop gets an alert.
 */
export async function submitBallDesign(slug: string, raw: Record<string, unknown>, files: { logo: File | null; proof: File | null }, meta: { ip: string | null }) {
  const shop = await findDesignShop(slug);
  if (!shop) throw new ServiceError('This design page isn’t available at the moment. Please contact the shop.');
  await checkDesignLimits(shop.org.id, meta.ip);
  const ctx = await customerDesignCtx(shop.org, String(raw.customerName ?? ''));
  const quote = await createBallPrintQuote(
    ctx,
    { ...raw, customerId: '', pricePerDozenPence: '1', setupFeePence: '0', validUntil: '' },
    files,
    { send: false, source: 'customer' },
  );
  await designSubmitted('ball', ctx, quote, meta.ip);
  return quote;
}

export async function setBallDesignLink(ctx: Ctx, enabled: boolean) {
  requireRole(ctx, 'manager', 'change the design link');
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ ballDesignLink: enabled }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { ballDesignLink: ctx.org.ballDesignLink }, newValue: { ballDesignLink: enabled }, metadata: { section: 'ball_printing.design_link' },
    });
  });
}

export { listSubmittedDesigns } from './online-designs';
