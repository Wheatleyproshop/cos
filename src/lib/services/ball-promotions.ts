import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { ballPromotions, customers, organisations, printBalls, quotes, type BallPromotion, type Organisation, type PromoBall } from '@/db/schema';
import { recordEvent } from '../audit';
import { asBallPrintSpec, LOGO_TYPES } from '../ball-print';
import { money, parseMoneyToPence } from '../format';
import { storage } from '../storage';
import { newToken } from '../tokens';
import { createBallPrintQuote, getBallRange, readImage } from './ball-printing';
import { requireRole, ServiceError, type Ctx } from './common';
import { checkDesignLimits, customerDesignCtx, designSubmitted } from './online-designs';

/**
 * Personalised-ball promotions (e.g. Titleist's "No.1 Gift in Golf"). The shop picks balls from its
 * print range and gives each a promotion price; customers open the link, design their logo ball on
 * the usual 3D designer (showing only those balls) and send it. Each design is a normal ball-print
 * quote, tagged with the promotion, for the shop to check before it goes into print.
 */

export const DEFAULT_PROMO_TERMS =
  'Promotion prices apply to designs sent before the closing date. We check every logo before printing and will be in touch to confirm the proof, quantity and price before anything goes into print. Personalised balls can’t be returned unless faulty.';

const t = (n: number) => z.string().trim().max(n, `Keep this under ${n} characters`).default('');
const pounds = (v: string) => {
  const p = parseMoneyToPence(v);
  return p === null || p < 0 || p > 1_000_000 ? null : p;
};

const setupSchema = z.object({
  title: z.string().trim().min(2, 'Give it a title').max(120),
  headline: t(160),
  description: t(1500),
  setupFee: z
    .string()
    .trim()
    .default('')
    .transform((v, ctx) => {
      if (!v) return 0;
      const p = pounds(v);
      if (p === null) {
        ctx.addIssue({ code: 'custom', message: 'Enter an amount, e.g. 0.00' });
        return z.NEVER;
      }
      return p;
    }),
  minDozens: z.coerce.number().int('Whole dozens').min(1, 'At least 1').max(500).default(1),
  terms: t(2000),
  closesOn: z
    .string()
    .trim()
    .default('')
    .refine((s) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s), 'Use a valid date')
    .transform((s) => s || null),
});

function fieldErrors(issues: z.core.$ZodIssue[]) {
  const out: Record<string, string> = {};
  for (const i of issues) out[String(i.path[0])] ??= i.message;
  return out;
}

/** Ball rows from the form: tick `ball_{id}` = "yes" and price `price_{id}`. Only balls in the shop's range count. */
async function readBalls(ctx: Ctx, raw: Record<string, string>) {
  const range = await getBallRange(ctx.org.id);
  const balls: PromoBall[] = [];
  const errs: Record<string, string> = {};
  for (const b of range) {
    if (raw[`ball_${b.id}`] !== 'yes') continue;
    const priceRaw = String(raw[`price_${b.id}`] ?? '').trim();
    const price = priceRaw ? pounds(priceRaw) : b.pricePerDozenPence;
    if (price === null || price === 0) errs[`price_${b.id}`] = 'Enter the promotion price per dozen, e.g. 54.99';
    else balls.push({ ballId: b.id, pricePerDozenPence: price });
  }
  if (!balls.length && !Object.keys(errs).length) errs.balls = 'Tick at least one ball';
  return { balls, errs };
}

async function parseSetup(ctx: Ctx, raw: Record<string, string>) {
  const res = setupSchema.safeParse(raw);
  const { balls, errs } = await readBalls(ctx, raw);
  const all = { ...(res.success ? {} : fieldErrors(res.error.issues)), ...errs };
  if (!res.success || Object.keys(all).length) throw new ServiceError('Please check the highlighted fields.', all);
  return { ...res.data, balls };
}

export const MAX_PROMO_IMAGE_BYTES = 4 * 1024 * 1024;
export type PromoImages = { banner?: File | null; feature?: File | null };
type ImageCols = { bannerKey?: string | null; bannerMime?: string | null; featureKey?: string | null; featureMime?: string | null };

/** Stores any new campaign images; `remove_banner` / `remove_feature` = "yes" clears one. */
async function readImages(ctx: Ctx, raw: Record<string, string>, files: PromoImages): Promise<ImageCols> {
  const out: ImageCols = {};
  for (const slot of ['banner', 'feature'] as const) {
    const img = await readImage(files[slot] ?? null, slot === 'banner' ? 'banner image' : 'feature image', MAX_PROMO_IMAGE_BYTES);
    if (img) {
      const key = `orgs/${ctx.org.id}/ball-promotions/${newToken().slice(0, 16)}.${LOGO_TYPES[img.mime]}`;
      await storage().put(key, img.buf, img.mime);
      out[`${slot}Key`] = key;
      out[`${slot}Mime`] = img.mime;
    } else if (raw[`remove_${slot}`] === 'yes') {
      out[`${slot}Key`] = null;
      out[`${slot}Mime`] = null;
    }
  }
  return out;
}

export async function createBallPromotion(ctx: Ctx, raw: Record<string, string>, files: PromoImages = {}) {
  requireRole(ctx, 'manager', 'set up ball promotions');
  const v = await parseSetup(ctx, raw);
  const images = await readImages(ctx, raw, files);
  return withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .insert(ballPromotions)
      .values({
        organisationId: ctx.org.id, token: newToken().slice(0, 22), title: v.title, headline: v.headline, description: v.description, balls: v.balls,
        setupFeePence: v.setupFee, minDozens: v.minDozens, terms: v.terms || DEFAULT_PROMO_TERMS, closesOn: v.closesOn, createdByUserId: ctx.userId!, ...images,
      })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'ball_promotion_created', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { promotionId: row.id, title: row.title, balls: v.balls, setupFeePence: v.setupFee, minDozens: v.minDozens, closesOn: v.closesOn },
    });
    return row;
  });
}

/** Edits the promotion. Designs already sent keep the prices they were sent at. */
export async function updateBallPromotion(ctx: Ctx, id: string, raw: Record<string, string>, files: PromoImages = {}) {
  requireRole(ctx, 'manager', 'change ball promotions');
  const v = await parseSetup(ctx, raw);
  const images = await readImages(ctx, raw, files);
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .update(ballPromotions)
      .set({
        title: v.title, headline: v.headline, description: v.description, balls: v.balls, setupFeePence: v.setupFee, minDozens: v.minDozens,
        terms: v.terms || DEFAULT_PROMO_TERMS, closesOn: v.closesOn, ...images,
      })
      .where(eq(ballPromotions.id, id))
      .returning({ id: ballPromotions.id });
    if (!row) throw new ServiceError('Promotion not found.');
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'ball_promotion_changed', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { promotionId: id, title: v.title, balls: v.balls, setupFeePence: v.setupFee, minDozens: v.minDozens, closesOn: v.closesOn },
    });
  });
}

export async function setBallPromotionClosed(ctx: Ctx, id: string, closed: boolean) {
  requireRole(ctx, 'manager', 'open or close ball promotions');
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.update(ballPromotions).set({ closedAt: closed ? new Date() : null }).where(eq(ballPromotions.id, id)).returning({ id: ballPromotions.id });
    if (!row) throw new ServiceError('Promotion not found.');
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: closed ? 'ball_promotion_closed' : 'ball_promotion_reopened', entityType: 'organisation',
      entityId: ctx.org.id, newValue: { promotionId: id },
    });
  });
}

export const isPromoOpen = (p: Pick<BallPromotion, 'closedAt' | 'closesOn'>, today: string) => !p.closedAt && (!p.closesOn || p.closesOn >= today);
export const londonToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const promoIdSql = sql`${quotes.specificationJson}->'promo'->>'id'`;

export async function listBallPromotions(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ballPromotions).orderBy(desc(ballPromotions.createdAt)).limit(100);
    const counts = await tx
      .select({
        id: sql<string>`${promoIdSql}`, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${quotes.totalGrossPence}), 0)::int`,
        dozens: sql<number>`coalesce(sum((${quotes.specificationJson}->>'dozens')::int), 0)::int`,
      })
      .from(quotes)
      .where(sql`${promoIdSql} is not null`)
      .groupBy(sql`1`);
    const range = await tx.select({ id: printBalls.id, brand: printBalls.brand, name: printBalls.name }).from(printBalls);
    return rows.map((r) => {
      const c = counts.find((x) => x.id === r.id);
      return { ...r, count: c?.n ?? 0, value: c?.value ?? 0, dozens: c?.dozens ?? 0, ballNames: r.balls.map((b) => range.find((x) => x.id === b.ballId)?.name ?? 'Ball no longer in range') };
    });
  });
}

export async function ballPromotionDetail(orgId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withTenant(orgId, async (tx) => {
    const [promo] = await tx.select().from(ballPromotions).where(eq(ballPromotions.id, id)).limit(1);
    if (!promo) return null;
    const rows = await tx
      .select({
        id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status, totalGrossPence: quotes.totalGrossPence, createdAt: quotes.createdAt,
        convertedOrderId: quotes.convertedOrderId, spec: quotes.specificationJson, customer: customers.name, email: customers.email, phone: customers.phone,
      })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(sql`${promoIdSql} = ${id}`, isNull(quotes.archivedAt)))
      .orderBy(quotes.createdAt);
    const designs = rows.map((r) => {
      const s = asBallPrintSpec(r.spec)!;
      return { ...r, ballId: s.ball.id, ball: `${s.ball.brand} ${s.ball.name}`, dozens: s.dozens, artwork: s.artwork.type === 'logo' ? 'Logo' : `“${s.artwork.lines.join(' / ')}”` };
    });
    const range = promo.balls.length ? await tx.select().from(printBalls).where(inArray(printBalls.id, promo.balls.map((b) => b.ballId))) : [];
    const balls = promo.balls.map((b) => {
      const r = range.find((x) => x.id === b.ballId);
      const mine = designs.filter((d) => d.ballId === b.ballId);
      return {
        ...b, brand: r?.brand ?? '', name: r?.name ?? 'Ball no longer in range', colour: r?.colour ?? '#ffffff', listPricePence: r?.pricePerDozenPence ?? null,
        designs: mine.length, dozens: mine.reduce((n, d) => n + d.dozens, 0),
      };
    });
    return {
      promo, designs, balls,
      totals: { designs: designs.length, dozens: designs.reduce((n, d) => n + d.dozens, 0), value: designs.reduce((n, d) => n + d.totalGrossPence, 0) },
    };
  });
}

export function promoCsv(d: NonNullable<Awaited<ReturnType<typeof ballPromotionDetail>>>) {
  const q = (v: string) => (/[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  const lines = [['Quote', 'Name', 'Email', 'Phone', 'Ball', 'Dozens', 'Personalisation', 'Total', 'Status', 'Sent on'].join(',')];
  for (const x of d.designs) {
    lines.push(
      [x.quoteNumber, x.customer, x.email, x.phone, x.ball, x.dozens, x.artwork, (x.totalGrossPence / 100).toFixed(2), x.status, x.createdAt.toISOString().slice(0, 10)]
        .map((v) => q(String(v)))
        .join(','),
    );
  }
  lines.push('', 'Ball,Designs,Dozens');
  for (const b of d.balls) lines.push([q(`${b.brand} ${b.name}`), b.designs, b.dozens].join(','));
  return lines.join('\n') + '\n';
}

/* ─────────────────────────────── Public link ─────────────────────────────── */

export async function findBallPromotion(token: string): Promise<{ promo: BallPromotion; org: Organisation; balls: (typeof printBalls.$inferSelect & { promoPricePence: number })[] } | null> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const db = systemDb();
  const [promo] = await db.select().from(ballPromotions).where(eq(ballPromotions.token, token)).limit(1);
  if (!promo) return null;
  const [org] = await db.select().from(organisations).where(eq(organisations.id, promo.organisationId)).limit(1);
  if (!org) return null;
  const range = await getBallRange(org.id);
  const balls = promo.balls
    .map((b) => {
      const r = range.find((x) => x.id === b.ballId);
      return r ? { ...r, promoPricePence: b.pricePerDozenPence } : null;
    })
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  return { promo, org, balls };
}

/** A customer sends their design through the promotion. It becomes a draft ball-print quote at the promotion price. */
export async function submitPromotionDesign(token: string, raw: Record<string, unknown>, files: { logo: File | null; proof: File | null }, meta: { ip: string | null }) {
  const found = await findBallPromotion(token);
  if (!found || !found.balls.length) throw new ServiceError('This promotion isn’t available. Please contact the shop.');
  const { promo, org, balls } = found;
  if (!isPromoOpen(promo, londonToday())) throw new ServiceError('This promotion has now closed. Please contact the shop.');
  const ball = balls.find((b) => b.id === String(raw.ballId ?? ''));
  if (!ball) throw new ServiceError('Please choose one of the balls in this promotion.', { ballId: 'Choose a ball' });
  await checkDesignLimits(org.id, meta.ip);
  const ctx = await customerDesignCtx(org, String(raw.customerName ?? ''));
  const quote = await createBallPrintQuote(
    ctx,
    { ...raw, customerId: '', pricePerDozenPence: '1', setupFeePence: '0', validUntil: '' },
    files,
    {
      send: false,
      source: 'customer',
      promo: { id: promo.id, title: promo.title, pricePerDozenPence: ball.promoPricePence, setupFeePence: promo.setupFeePence, minDozens: promo.minDozens },
    },
  );
  await designSubmitted('ball', ctx, quote, meta.ip);
  return quote;
}

export const promoPriceText = (b: { promoPricePence: number; pricePerDozenPence: number }) =>
  b.promoPricePence < b.pricePerDozenPence ? `${money(b.promoPricePence)} a dozen (usually ${money(b.pricePerDozenPence)})` : `${money(b.promoPricePence)} a dozen`;

/** Public path for a promotion's campaign image (the key's tail busts the cache when it changes). */
export const promoImagePath = (p: Pick<BallPromotion, 'token' | 'bannerKey' | 'featureKey'>, slot: 'banner' | 'feature') => {
  const key = slot === 'banner' ? p.bannerKey : p.featureKey;
  return key ? `/api/public/promo-image/${p.token}/${slot}?v=${key.slice(-10)}` : null;
};
