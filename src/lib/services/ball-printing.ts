import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import { organisations, printBalls } from '@/db/schema';
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
import { createQuote } from './quotes';

export async function getBallRange(orgId: string, opts: { includeInactive?: boolean } = {}) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(printBalls)
      .where(opts.includeInactive ? undefined : eq(printBalls.active, true))
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
  await withTenant(ctx.org.id, (tx) => tx.insert(printBalls).values({ organisationId: ctx.org.id, ...v, leadTimeDays: v.leadTimeDays || null }));
  await auditCatalogue(ctx, 'ball_added', v);
}

export async function updateBallPrice(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the ball range');
  const v = parse(z.object({ pricePerDozenPence: pence('Price per dozen', 1) }), raw);
  await withTenant(ctx.org.id, (tx) =>
    tx.update(printBalls).set(v).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))),
  );
  await auditCatalogue(ctx, 'ball_price_changed', { id, ...v });
}

/** Balls are retired, never deleted, so old quotes keep their references. */
export async function setBallActive(ctx: Ctx, id: string, active: boolean) {
  requireRole(ctx, 'manager', 'edit the ball range');
  await withTenant(ctx.org.id, (tx) =>
    tx.update(printBalls).set({ active }).where(and(eq(printBalls.id, id), eq(printBalls.organisationId, ctx.org.id))),
  );
  await auditCatalogue(ctx, active ? 'ball_restored' : 'ball_retired', { id });
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

async function readImage(file: File | null, what: string, maxBytes: number) {
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
export async function createBallPrintQuote(ctx: Ctx, raw: unknown, files: { logo: File | null; proof: File | null }, opts: { send: boolean }) {
  const input = parse(printSchema, raw);
  const [ball] = await withTenant(ctx.org.id, (tx) =>
    tx.select().from(printBalls).where(and(eq(printBalls.id, input.ballId), eq(printBalls.active, true))).limit(1),
  );
  if (!ball) throw new ServiceError('That ball is no longer in your range.', { ballId: 'Choose another ball' });
  if (input.dozens < ball.minDozens) {
    throw new ServiceError(`The ${ball.name} has a minimum of ${ball.minDozens} dozen.`, { dozens: `Minimum ${ball.minDozens}` });
  }

  const lines = input.textLines.filter(Boolean);
  if (input.artworkType === 'text' && !lines.length) throw new ServiceError('Enter the text to print.', { textLines: 'Required' });
  const logo = input.artworkType === 'logo' ? await readImage(files.logo, 'logo', MAX_LOGO_BYTES) : null;
  if (input.artworkType === 'logo' && !logo) throw new ServiceError('Upload the customer’s logo.', { logo: 'Required' });
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
      internalNotes: 'Created with Ball Printing.',
    },
    { send: opts.send, specificationJson: spec },
  );
}
