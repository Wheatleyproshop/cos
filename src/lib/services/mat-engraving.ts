import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { organisations, type Organisation } from '@/db/schema';
import { recordEvent } from '../audit';
import { LOGO_TYPES, MAX_LOGO_BYTES, MAX_PROOF_BYTES, PRINT_FONTS, type PrintFontKey } from '../ball-print';
import { money, parseMoneyToPence } from '../format';
import { hasTransparency, MAT_LOGO_HELP, MAT_LOGO_TYPES, MAT_POSITIONS, matPositionOf, matPrices, OWN_MAT, type MatEngraving, type MatPositionKey, type MatSpec } from '../mat-engraving';
import { storage } from '../storage';
import { newToken } from '../tokens';
import { customerFields, parse } from '../validation';
import { readImage } from './ball-printing';
import { requireRole, ServiceError, type Ctx } from './common';
import { checkDesignLimits, customerDesignCtx, designSubmitted } from './online-designs';
import { createQuote } from './quotes';

export const MAX_MAT_LOGOS = 2;

const pence = (label: string) =>
  z.union([z.string(), z.number()]).transform((v, c) => {
    const p = parseMoneyToPence(String(v || '0'));
    if (p === null || p < 0) {
      c.addIssue({ code: 'custom', message: `${label} must be an amount like 10.00` });
      return z.NEVER;
    }
    return p;
  });

/* ───────────────────────────── Prices ───────────────────────────── */

export async function updateMatPrices(ctx: Ctx, raw: Record<string, unknown>) {
  requireRole(ctx, 'manager', 'change mat engraving prices');
  const before = matPrices(ctx.org.matEngraving);
  const v = parse(
    z.object({
      short: pence('Short pile mat price'),
      long: pence('Long pile mat price'),
      lip: pence('Front lip engraving'),
      underside: pence('Underside engraving'),
      setupFeePence: pence('Setup fee'),
    }),
    raw,
  );
  const next = {
    mats: before.mats.map((m) => ({ ...m, pricePence: v[m.key] })),
    positions: { lip: v.lip, underside: v.underside },
    setupFeePence: v.setupFeePence,
  };
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ matEngraving: next }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { matEngraving: before }, newValue: { matEngraving: next }, metadata: { section: 'mat_engraving.prices' },
    });
  });
}

/* ───────────────────────────── Quotes ───────────────────────────── */

const fontKeys = PRINT_FONTS.map((f) => f.key) as [string, ...string[]];

const engravingSchema = z.object({
  position: z.enum(MAT_POSITIONS.map((p) => p.key) as [MatPositionKey, ...MatPositionKey[]]),
  scale: z.coerce.number().min(0.2).max(1).default(0.8),
  artwork: z.discriminatedUnion('type', [
    z.object({ type: z.literal('logo'), logo: z.number().int().min(0).max(MAX_MAT_LOGOS - 1) }),
    z.object({ type: z.literal('text'), lines: z.array(z.string().trim().max(28, 'Keep each line to 28 characters')).max(2), font: z.enum(fontKeys).default('modern') }),
  ]),
});

const matSchema = z.object({
  ...customerFields,
  mat: z.enum(['short', 'long', OWN_MAT], { message: 'Choose the mat' }),
  matPricePence: pence('Mat price'),
  quantity: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(200),
  engravings: z.string().transform((v, c) => {
    try {
      const r = z.array(engravingSchema).min(1, 'Add a name or logo to engrave').max(2).safeParse(JSON.parse(v));
      if (r.success) return r.data;
      c.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? 'Check the engraving' });
    } catch {
      c.addIssue({ code: 'custom', message: 'Check the engraving' });
    }
    return z.NEVER;
  }),
  setupFeePence: pence('Setup fee'),
  notes: z.string().trim().max(2000).default(''),
  validUntil: z.string().trim().default(''),
});

/**
 * Turns a mat engraving design into a normal quote (approval, conversion and audit are shared). The
 * customer's logos and the rendered proof go to private storage, referenced from the spec. Approving
 * it sends the job straight for engraving.
 */
export async function createMatQuote(
  ctx: Ctx,
  raw: unknown,
  files: { logos: (File | null)[]; proof: File | null },
  opts: { send: boolean; source?: 'staff' | 'customer' },
) {
  const fromCustomer = opts.source === 'customer';
  const input = parse(matSchema, raw);
  const prices = matPrices(ctx.org.matEngraving);
  const option = prices.mats.find((m) => m.key === input.mat);
  const matName = option?.name ?? 'Customer’s own mat';
  // Online designs pay the shop's prices; staff can adjust the mat price on a job.
  if (fromCustomer) {
    input.matPricePence = option?.pricePence ?? 0;
    input.setupFeePence = prices.setupFeePence;
    input.validUntil = '';
    input.customerId = null;
  } else if (!option) {
    input.matPricePence = 0;
  }
  if (new Set(input.engravings.map((e) => e.position)).size !== input.engravings.length) throw new ServiceError('Each place can only be engraved once.');
  for (const e of input.engravings) {
    if (e.artwork.type === 'text' && !e.artwork.lines.some(Boolean)) throw new ServiceError(`Enter the text for the ${matPositionOf(e.position)!.label.toLowerCase()}.`);
  }
  const proof = await readImage(files.proof, 'preview', MAX_PROOF_BYTES);
  if (!proof) throw new ServiceError('The preview could not be created. Please try again.');

  const id = newToken().slice(0, 16);
  const base = `orgs/${ctx.org.id}/mat-engraving/${id}`;
  const put = async (name: string, img: { buf: Buffer; mime: string }) => {
    const key = `${base}-${name}.${LOGO_TYPES[img.mime]}`;
    await storage().put(key, img.buf, img.mime);
    return { storageKey: key, mimeType: img.mime };
  };

  const logos = new Map<number, { storageKey: string; mimeType: string; filename: string }>();
  for (const i of new Set(input.engravings.flatMap((e) => (e.artwork.type === 'logo' ? [e.artwork.logo] : [])))) {
    const img = await readImage(files.logos[i] ?? null, 'logo', MAX_LOGO_BYTES);
    if (!img) throw new ServiceError('Upload the logo to engrave.', { logo: 'Required' });
    if (!MAT_LOGO_TYPES.includes(img.mime) || !hasTransparency(img.buf, img.mime)) throw new ServiceError(`Logo ${i + 1} needs a transparent background. ${MAT_LOGO_HELP}`, { logo: 'Transparent PNG needed' });
    const filename = (files.logos[i]!.name || `logo-${i + 1}`).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    logos.set(i, { ...(await put(`logo-${i + 1}`, img)), filename });
  }
  const proofStored = await put('proof', proof);

  const engravings: MatEngraving[] = input.engravings.map((e) => ({
    position: e.position,
    scale: e.scale,
    pricePence: prices.positions[e.position],
    artwork: e.artwork.type === 'logo' ? { type: 'logo', logo: e.artwork.logo, ...logos.get(e.artwork.logo)! } : { type: 'text', lines: e.artwork.lines.filter(Boolean), font: e.artwork.font as PrintFontKey },
  }));

  const engravingEach = engravings.reduce((t, e) => t + e.pricePence, 0);
  const each = input.matPricePence + engravingEach;
  const total = input.quantity * each + input.setupFeePence;
  const fontLabel = (k: string) => PRINT_FONTS.find((f) => f.key === k)!.label.toLowerCase();
  const specLines = [
    `Mat: ${matName}${input.quantity > 1 ? ` × ${input.quantity}` : ''}`,
    ...engravings.map((e) => {
      const what = e.artwork.type === 'logo' ? `logo (${e.artwork.filename})` : `“${e.artwork.lines.join(' / ')}” in ${fontLabel(e.artwork.font)}`;
      return `${matPositionOf(e.position)!.label}: laser engraved — ${what} (${money(e.pricePence)} each)`;
    }),
    `Price each: ${money(each)}${input.matPricePence ? ` (mat ${money(input.matPricePence)} + engraving ${money(engravingEach)})` : ' (engraving only)'}`,
    ...(input.setupFeePence ? [`Setup: ${money(input.setupFeePence)}`] : []),
    ...(input.notes ? ['', input.notes] : []),
  ];

  const spec: MatSpec = {
    kind: 'cos-mat-engraving',
    version: 1,
    mat: { name: matName, pricePence: input.matPricePence, pile: option?.key ?? null },
    quantity: input.quantity,
    engravings,
    setupFeePence: input.setupFeePence,
    proofKey: proofStored.storageKey,
    notes: input.notes,
    totalPence: total,
    ...(fromCustomer ? { submittedOnline: true } : {}),
  };

  return createQuote(
    ctx,
    {
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
      customerId: input.customerId ?? '',
      // "Spurk Fairway Mat — Short Pile" → brand Spurk, product "Fairway Mat — Short Pile (engraved)".
      brand: option ? matName.split(' ')[0] : 'Engraving',
      category: 'Accessories',
      product: option ? `${matName.split(' ').slice(1).join(' ')} (engraved)` : 'Customer’s own mat',
      sku: '',
      specificationText: specLines.join('\n'),
      totalGrossPence: (total / 100).toFixed(2),
      depositRequiredPence: '0',
      estimatedLeadTime: '',
      validUntil: input.validUntil,
      internalNotes: fromCustomer
        ? 'Designed and submitted online by the customer. Check the design and price, then email the proof back for approval or approve it in store.'
        : 'Created with Mat Engraving.',
    },
    { send: opts.send, specificationJson: spec },
  );
}

/* ─────────────────── Customer design link (/design/<slug>/mat) ─────────────────── */

export const matDesignPathFor = (org: Pick<Organisation, 'slug'>) => `/design/${org.slug}/mat`;

/** The shop behind a public mat engraving link, if it's switched on. */
export async function findMatShop(slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, slug)).limit(1);
  return org?.matDesignLink ? { org } : null;
}

/** A customer sends in their own mat engraving design: a draft quote at the shop's prices, for the shop to review. */
export async function submitMatDesign(slug: string, raw: Record<string, unknown>, files: { logos: (File | null)[]; proof: File | null }, meta: { ip: string | null }) {
  const shop = await findMatShop(slug);
  if (!shop) throw new ServiceError('This design page isn’t available at the moment. Please contact the shop.');
  await checkDesignLimits(shop.org.id, meta.ip);
  const ctx = await customerDesignCtx(shop.org, String(raw.customerName ?? ''));
  // Prices aren't on the customer's form: the shop's own are applied in createMatQuote.
  const quote = await createMatQuote(ctx, { ...raw, customerId: '', matPricePence: '0', setupFeePence: '0', validUntil: '' }, files, { send: false, source: 'customer' });
  await designSubmitted('engraving', ctx, quote, meta.ip);
  return quote;
}

export async function setMatDesignLink(ctx: Ctx, enabled: boolean) {
  requireRole(ctx, 'manager', 'change the design link');
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ matDesignLink: enabled }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { matDesignLink: ctx.org.matDesignLink }, newValue: { matDesignLink: enabled }, metadata: { section: 'mat_engraving.design_link' },
    });
  });
}
