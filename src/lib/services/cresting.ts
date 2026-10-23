import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { organisations, type Organisation } from '@/db/schema';
import { recordEvent } from '../audit';
import { LOGO_TYPES, MAX_LOGO_BYTES, MAX_PROOF_BYTES, PRINT_FONTS, type PrintFontKey } from '../ball-print';
import {
  APPAREL_SIZES,
  CAP_SIZES,
  CREST_METHODS,
  CREST_POSITIONS,
  crestPrices,
  itemPrice,
  positionOf,
  sizesText,
  THREAD_COLOURS,
  type CrestPlacement,
  type CrestPositionKey,
  type CrestSpec,
  type ThreadKey,
} from '../cresting';
import { money, parseMoneyToPence } from '../format';
import { storage } from '../storage';
import { newToken } from '../tokens';
import { customerFields, parse } from '../validation';
import { readImage } from './ball-printing';
import { requireRole, ServiceError, type Ctx } from './common';
import { checkDesignLimits, customerDesignCtx, designSubmitted } from './online-designs';
import { createQuote } from './quotes';

export const MAX_CREST_LOGOS = 3;
const MAX_GARMENT_BYTES = 2 * 1024 * 1024;

const pence = (label: string, min = 0) =>
  z.union([z.string(), z.number()]).transform((v, c) => {
    const p = parseMoneyToPence(String(v || '0'));
    if (p === null || p < min) {
      c.addIssue({ code: 'custom', message: `${label} must be an amount like 6.00` });
      return z.NEVER;
    }
    return p;
  });

/* ───────────────────────────── Prices ───────────────────────────── */

export async function updateCrestPrices(ctx: Ctx, raw: Record<string, unknown>) {
  requireRole(ctx, 'manager', 'change cresting prices');
  const next = crestPrices(ctx.org.crestingPrices);
  for (const p of CREST_POSITIONS) {
    for (const m of CREST_METHODS) {
      const k = `${p.key}.${m.key}`;
      if (raw[k] === undefined) continue;
      next.positions[p.key][m.key] = parse(z.object({ v: pence(`${p.label} ${m.label.toLowerCase()}`) }), { v: raw[k] }).v;
    }
  }
  if (raw.setupFeePence !== undefined) next.setupFeePence = parse(z.object({ v: pence('Setup fee') }), { v: raw.setupFeePence }).v;
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ crestingPrices: next }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { crestingPrices: crestPrices(ctx.org.crestingPrices) }, newValue: { crestingPrices: next }, metadata: { section: 'cresting.prices' },
    });
  });
}

/* ───────────────────────────── Quotes ───────────────────────────── */

const fontKeys = PRINT_FONTS.map((f) => f.key) as [string, ...string[]];
const threadKeys = THREAD_COLOURS.map((c) => c.key) as [string, ...string[]];
const positionKeys = CREST_POSITIONS.map((p) => p.key) as [string, ...string[]];
const frac = z.coerce.number().min(0).max(1);

const placementSchema = z.object({
  position: z.enum(positionKeys),
  method: z.enum(['embroidery', 'print']),
  colour: z.enum(threadKeys).default('white'),
  x: frac,
  y: frac,
  w: z.coerce.number().min(0.03).max(0.9),
  artwork: z.discriminatedUnion('type', [
    z.object({ type: z.literal('logo'), logo: z.number().int().min(0).max(MAX_CREST_LOGOS - 1) }),
    z.object({
      type: z.literal('text'),
      lines: z.array(z.string().trim().max(30, 'Keep each line to 30 characters')).max(3),
      font: z.enum(fontKeys).default('modern'),
    }),
  ]),
});

const jsonOf = <S extends z.ZodType>(schema: S, label: string) =>
  z.string().transform((v, c) => {
    try {
      const r = schema.safeParse(JSON.parse(v));
      if (r.success) return r.data as z.output<S>;
      c.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? `Check the ${label}` });
    } catch {
      c.addIssue({ code: 'custom', message: `Check the ${label}` });
    }
    return z.NEVER;
  });

const crestSchema = z.object({
  ...customerFields,
  garmentType: z.enum(['apparel', 'cap']).default('apparel'),
  garmentBrand: z.string().trim().max(80).default(''),
  garmentDescription: z.string().trim().min(1, 'Describe the garment, e.g. Performance polo').max(120),
  garmentColour: z.string().trim().max(60).default(''),
  garmentPricePence: pence('Garment price'),
  placements: jsonOf(z.array(placementSchema).min(1, 'Add at least one logo or text').max(7), 'logo positions'),
  sizes: jsonOf(z.record(z.string(), z.coerce.number().int().min(0).max(999)), 'sizes'),
  setupFeePence: pence('Setup fee'),
  notes: z.string().trim().max(2000).default(''),
  validUntil: z.string().trim().default(''),
});

/**
 * Turns a cresting design into a normal quote, like ball printing: the garment photos, the
 * customer's logos and the rendered proof are kept in private storage and referenced from the spec.
 * Approving it puts the order straight into production.
 */
export async function createCrestQuote(
  ctx: Ctx,
  raw: unknown,
  files: { front: File | null; back: File | null; logos: (File | null)[]; proof: File | null },
  opts: { send: boolean; source?: 'staff' | 'customer' },
) {
  const fromCustomer = opts.source === 'customer';
  const input = parse(crestSchema, raw);
  const prices = crestPrices(ctx.org.crestingPrices);
  // Online designs: the shop's own prices; the garment price is confirmed by staff when they review it.
  if (fromCustomer) {
    input.garmentPricePence = 0;
    input.setupFeePence = prices.setupFeePence;
    input.validUntil = '';
    input.customerId = null;
  }
  const sizeList: readonly string[] = input.garmentType === 'cap' ? CAP_SIZES : APPAREL_SIZES;
  const sizes = Object.fromEntries(Object.entries(input.sizes).filter(([s, n]) => sizeList.includes(s) && n > 0));
  const quantity = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (!quantity) throw new ServiceError('Enter how many of each size.', { sizes: 'At least 1 item' });

  const front = await readImage(files.front, 'garment photo', MAX_GARMENT_BYTES);
  if (!front) throw new ServiceError('Upload a photo of the garment.', { front: 'Required' });
  const back = await readImage(files.back, 'back photo', MAX_GARMENT_BYTES);
  const proof = await readImage(files.proof, 'preview', MAX_PROOF_BYTES);
  if (!proof) throw new ServiceError('The preview could not be created. Please try again.');

  for (const p of input.placements) {
    const pos = positionOf(p.position)!;
    if (pos.garment !== input.garmentType) throw new ServiceError(`${pos.label} isn’t a position on this garment.`);
    if (pos.view === 'back' && !back) {
      throw new ServiceError(`Add a ${input.garmentType === 'cap' ? 'side' : 'back'} photo for the ${pos.label.toLowerCase()} position.`, { back: 'Required' });
    }
    if (p.artwork.type === 'text' && !p.artwork.lines.some(Boolean)) throw new ServiceError(`Enter the text for the ${pos.label.toLowerCase()}.`);
  }
  if (new Set(input.placements.map((p) => p.position)).size !== input.placements.length) {
    throw new ServiceError('Each position can only be used once.');
  }

  const id = newToken().slice(0, 16);
  const base = `orgs/${ctx.org.id}/cresting/${id}`;
  const put = async (name: string, img: { buf: Buffer; mime: string }) => {
    const key = `${base}-${name}.${LOGO_TYPES[img.mime]}`;
    await storage().put(key, img.buf, img.mime);
    return { storageKey: key, mimeType: img.mime };
  };

  // Only the logos a placement actually uses are stored.
  const used = new Set(input.placements.flatMap((p) => (p.artwork.type === 'logo' ? [p.artwork.logo] : [])));
  const logos = new Map<number, { storageKey: string; mimeType: string; filename: string }>();
  for (const i of used) {
    const img = await readImage(files.logos[i] ?? null, 'logo', MAX_LOGO_BYTES);
    if (!img) throw new ServiceError('Upload the logo for each logo position.', { logo: 'Required' });
    const filename = (files.logos[i]!.name || `logo-${i + 1}`).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    logos.set(i, { ...(await put(`logo-${i + 1}`, img)), filename });
  }

  const photos: CrestSpec['photos'] = { front: await put('front', front), ...(back ? { back: await put('back', back) } : {}) };
  const proofStored = await put('proof', proof);

  const placements: CrestPlacement[] = input.placements.map((p) => ({
    position: p.position as CrestPositionKey,
    method: p.method,
    colour: p.colour as ThreadKey,
    x: p.x,
    y: p.y,
    w: p.w,
    pricePence: prices.positions[p.position][p.method],
    artwork:
      p.artwork.type === 'logo'
        ? { type: 'logo', logo: p.artwork.logo, ...logos.get(p.artwork.logo)! }
        : { type: 'text', lines: p.artwork.lines.filter(Boolean), font: p.artwork.font as PrintFontKey },
  }));

  const each = itemPrice(input.garmentPricePence, placements);
  const total = quantity * each + input.setupFeePence;
  const garmentName = [input.garmentBrand, input.garmentDescription, input.garmentColour ? `(${input.garmentColour})` : ''].filter(Boolean).join(' ');
  const methodLabel = (m: string) => CREST_METHODS.find((x) => x.key === m)!.label;
  const colourLabel = (c: string) => THREAD_COLOURS.find((x) => x.key === c)!.label;
  const specLines = [
    `Garment: ${garmentName}`,
    `Sizes: ${sizesText(sizes)} (${quantity} item${quantity === 1 ? '' : 's'})`,
    ...placements.map((p) => {
      const what =
        p.artwork.type === 'logo'
          ? `logo (${p.artwork.filename})`
          : `“${p.artwork.lines.join(' / ')}” in ${PRINT_FONTS.find((f) => f.key === (p.artwork as { font: string }).font)!.label.toLowerCase()}, ${colourLabel(p.colour).toLowerCase()}`;
      return `${positionOf(p.position)!.label}: ${methodLabel(p.method)} — ${what} (${money(p.pricePence)} each)`;
    }),
    fromCustomer
      ? `Cresting each: ${money(each)} — garment price to be confirmed by the shop`
      : `Price each: ${money(each)} (garment ${money(input.garmentPricePence)} + cresting ${money(each - input.garmentPricePence)})`,
    ...(input.setupFeePence ? [`Setup / digitising: ${money(input.setupFeePence)}`] : []),
    ...(input.notes ? ['', input.notes] : []),
  ];

  const spec: CrestSpec = {
    kind: 'cos-cresting',
    version: 1,
    garment: { type: input.garmentType, brand: input.garmentBrand, description: input.garmentDescription, colour: input.garmentColour, pricePence: input.garmentPricePence },
    photos,
    placements,
    sizes,
    quantity,
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
      brand: input.garmentBrand || 'Cresting',
      category: input.garmentType === 'cap' ? 'Headwear' : 'Clothing',
      product: `${input.garmentDescription} (crested)`,
      sku: '',
      specificationText: specLines.join('\n'),
      totalGrossPence: (total / 100).toFixed(2),
      depositRequiredPence: '0',
      estimatedLeadTime: '',
      validUntil: input.validUntil,
      internalNotes: fromCustomer
        ? 'Designed and submitted online by the customer. Add the garment price (Edit quote), check the artwork, then email the proof back or approve it in store.'
        : 'Created with Clothing Cresting.',
    },
    { send: opts.send, specificationJson: spec },
  );
}

/* ─────────────────── Customer design link (/design/<slug>/clothing) ─────────────────── */

export const crestDesignPathFor = (org: Pick<Organisation, 'slug'>) => `/design/${org.slug}/clothing`;

/** The shop behind a public cresting link, if it's switched on. */
export async function findCrestShop(slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, slug)).limit(1);
  return org?.crestDesignLink ? { org } : null;
}

/** A customer sends in their own cresting design: a draft quote (cresting priced, garment to confirm) for the shop to review. */
export async function submitCrestDesign(
  slug: string,
  raw: Record<string, unknown>,
  files: { front: File | null; back: File | null; logos: (File | null)[]; proof: File | null },
  meta: { ip: string | null },
) {
  const shop = await findCrestShop(slug);
  if (!shop) throw new ServiceError('This design page isn’t available at the moment. Please contact the shop.');
  await checkDesignLimits(shop.org.id, meta.ip);
  const ctx = await customerDesignCtx(shop.org, String(raw.customerName ?? ''));
  // Prices aren't on the customer's form: the shop's own are applied in createCrestQuote.
  const quote = await createCrestQuote(ctx, { ...raw, customerId: '', garmentPricePence: '0', setupFeePence: '0', validUntil: '' }, files, { send: false, source: 'customer' });
  await designSubmitted('cresting', ctx, quote, meta.ip);
  return quote;
}

export async function setCrestDesignLink(ctx: Ctx, enabled: boolean) {
  requireRole(ctx, 'manager', 'change the design link');
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ crestDesignLink: enabled }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { crestDesignLink: ctx.org.crestDesignLink }, newValue: { crestDesignLink: enabled }, metadata: { section: 'cresting.design_link' },
    });
  });
}
