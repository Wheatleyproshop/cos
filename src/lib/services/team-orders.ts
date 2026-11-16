import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { auditEvents, customers, organisations, orders, teamOrders, type Organisation, type TeamItem, type TeamOrder } from '@/db/schema';
import { recordEvent } from '../audit';
import { LOGO_TYPES } from '../ball-print';
import { money, parseMoneyToPence } from '../format';
import { storage } from '../storage';
import { newToken } from '../tokens';
import { readImage } from './ball-printing';
import { requireRole, ServiceError, type Ctx } from './common';
import { customerDesignCtx } from './online-designs';
import { createOrder } from './orders';

/**
 * Team-wear order links: a club team chooses a few garments at set prices (crest included); each
 * member opens the link, picks a size for the ones they want, adds their name if they like (extra
 * charge per garment) and accepts the order. Each response is one normal COS order ("To place";
 * several garments make a multi-item order), so it shows on the order board, the supplier sheets
 * and in the customer's emails like any other.
 */

export type TeamLine = { itemId: string; product: string; size: string };
export type TeamSpec = { teamOrderId: string; printedName: string; lines: TeamLine[] };
/** Team details ride along in the order's specification JSON under `team` (alongside any item list). */
export const asTeamSpec = (json: unknown): TeamSpec | null => {
  const t = (json as { team?: TeamSpec } | null)?.team;
  return t && typeof t.teamOrderId === 'string' && Array.isArray(t.lines) ? t : null;
};

export const TEAM_LIMITS = { perIpPerHour: 30, perLinkPerDay: 300 };
export const MAX_TEAM_ITEMS = 8;
export const DEFAULT_TEAM_TERMS =
  'By placing this order you’re agreeing to buy these items at the prices shown. They’re ordered in especially for you, so they can’t be returned or exchanged unless faulty — please check your sizes before you order. Payment is due when you collect.';
export const MAX_TEAM_IMAGE_BYTES = 4 * 1024 * 1024;

const t = (n: number) => z.string().trim().max(n, `Keep this under ${n} characters`).default('');
const pounds = (v: string) => {
  const p = parseMoneyToPence(v);
  return p === null || p < 0 || p > 1_000_000 ? null : p;
};

export function parseSizes(raw: string) {
  const seen = new Set<string>();
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 20 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 30);
}

const setupSchema = z.object({
  title: z.string().trim().min(2, 'Give it a title').max(120),
  teamName: t(120),
  brand: z.string().trim().min(1, 'Which brand?').max(80),
  description: t(1000),
  namePrice: z
    .string()
    .trim()
    .default('')
    .transform((v, ctx) => {
      if (!v) return 0;
      const p = pounds(v);
      if (p === null) {
        ctx.addIssue({ code: 'custom', message: 'Enter an amount, e.g. 5.00' });
        return z.NEVER;
      }
      return p;
    }),
  namePlacement: t(60),
  nameMaxLength: z.coerce.number().int().min(3, 'At least 3').max(40, 'Up to 40').default(20),
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

/** Garment rows from the setup form: `item{n}_product`, `_colour`, `_price`, `_sizes`, `_id`, photo `item{n}_photo`. Blank rows are skipped. */
async function readItems(ctx: Ctx, raw: Record<string, string>, photos: (File | null)[], existing: TeamItem[]) {
  const items: TeamItem[] = [];
  const slot: number[] = [];
  const errs: Record<string, string> = {};
  for (let n = 0; n < MAX_TEAM_ITEMS; n++) {
    const f = (k: string) => String(raw[`item${n}_${k}`] ?? '').trim();
    const product = f('product');
    if (!product) continue;
    const price = pounds(f('price'));
    const sizes = parseSizes(f('sizes'));
    if (product.length > 160) errs[`item${n}_product`] = 'Keep this under 160 characters';
    if (price === null || price === 0) errs[`item${n}_price`] = 'Enter the price, e.g. 49.99';
    if (!sizes.length) errs[`item${n}_sizes`] = 'List the sizes, separated by commas';
    const before = existing.find((e) => e.id === f('id'));
    items.push({
      id: before?.id ?? newToken().slice(0, 10), product, colour: f('colour').slice(0, 60), pricePence: price ?? 0, sizes,
      imageKey: before?.imageKey ?? null, imageMime: before?.imageMime ?? null,
    });
    slot.push(n);
  }
  if (!items.length) errs.item0_product = 'Add at least one garment';
  if (Object.keys(errs).length) throw new ServiceError('Please check the highlighted fields.', errs);
  for (const [i, it] of items.entries()) {
    const img = await readImage(photos[slot[i]] ?? null, `photo for ${it.product}`, MAX_TEAM_IMAGE_BYTES);
    if (img) {
      it.imageKey = `orgs/${ctx.org.id}/team-orders/${newToken().slice(0, 16)}.${LOGO_TYPES[img.mime]}`;
      it.imageMime = img.mime;
      await storage().put(it.imageKey, img.buf, img.mime);
    }
  }
  return items;
}

function parseSetup(raw: Record<string, string>) {
  const res = setupSchema.safeParse(raw);
  if (!res.success) throw new ServiceError('Please check the highlighted fields.', fieldErrors(res.error.issues));
  return res.data;
}

/** Creates the link (manager or admin). */
export async function createTeamOrder(ctx: Ctx, raw: Record<string, string>, photos: (File | null)[]) {
  requireRole(ctx, 'manager', 'set up team orders');
  const v = parseSetup(raw);
  const items = await readItems(ctx, raw, photos, []);
  return withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .insert(teamOrders)
      .values({
        organisationId: ctx.org.id, token: newToken().slice(0, 22), title: v.title, teamName: v.teamName, brand: v.brand, description: v.description, items,
        namePricePence: v.namePrice, namePlacement: v.namePlacement, nameMaxLength: v.nameMaxLength, terms: v.terms || DEFAULT_TEAM_TERMS, closesOn: v.closesOn,
        createdByUserId: ctx.userId!,
      })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'team_order_created', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { teamOrderId: row.id, title: row.title, items: items.map((i) => ({ product: i.product, pricePence: i.pricePence })), namePricePence: row.namePricePence },
    });
    return row;
  });
}

/** Edits the link's details. Orders already placed keep the prices they were placed at. */
export async function updateTeamOrder(ctx: Ctx, id: string, raw: Record<string, string>, photos: (File | null)[]) {
  requireRole(ctx, 'manager', 'change team orders');
  const v = parseSetup(raw);
  const [current] = await withTenant(ctx.org.id, (tx) => tx.select().from(teamOrders).where(eq(teamOrders.id, id)).limit(1));
  if (!current) throw new ServiceError('Team order not found.');
  const items = await readItems(ctx, raw, photos, current.items);
  await withTenant(ctx.org.id, async (tx) => {
    await tx
      .update(teamOrders)
      .set({
        title: v.title, teamName: v.teamName, brand: v.brand, description: v.description, items, namePricePence: v.namePrice, namePlacement: v.namePlacement,
        nameMaxLength: v.nameMaxLength, terms: v.terms || DEFAULT_TEAM_TERMS, closesOn: v.closesOn,
      })
      .where(eq(teamOrders.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'team_order_changed', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { teamOrderId: id, title: v.title, items: items.map((i) => ({ product: i.product, pricePence: i.pricePence })), namePricePence: v.namePrice, closesOn: v.closesOn },
    });
  });
}

export async function setTeamOrderClosed(ctx: Ctx, id: string, closed: boolean) {
  requireRole(ctx, 'manager', 'open or close team orders');
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.update(teamOrders).set({ closedAt: closed ? new Date() : null }).where(eq(teamOrders.id, id)).returning({ id: teamOrders.id });
    if (!row) throw new ServiceError('Team order not found.');
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: closed ? 'team_order_closed' : 'team_order_reopened', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { teamOrderId: id },
    });
  });
}

export const isOpen = (t: Pick<TeamOrder, 'closedAt' | 'closesOn'>, today: string) => !t.closedAt && (!t.closesOn || t.closesOn >= today);
export const londonToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const teamIdSql = sql`${orders.specificationJson}->'team'->>'teamOrderId'`;

export async function listTeamOrders(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(teamOrders).orderBy(desc(teamOrders.createdAt)).limit(100);
    const counts = await tx
      .select({ id: sql<string>`${teamIdSql}`, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${orders.totalGrossPence}), 0)::int` })
      .from(orders)
      .where(and(sql`${teamIdSql} is not null`, isNull(orders.removedAt)))
      .groupBy(sql`1`);
    return rows.map((r) => {
      const c = counts.find((x) => x.id === r.id);
      return { ...r, count: c?.n ?? 0, value: c?.value ?? 0 };
    });
  });
}

export async function teamOrderDetail(orgId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await withTenant(orgId, (tx) => tx.select().from(teamOrders).where(eq(teamOrders.id, id)).limit(1));
  if (!row) return null;
  const list = (
    await withTenant(orgId, (tx) =>
      tx
        .select({
          id: orders.id, orderNumber: orders.orderNumber, status: orders.status, totalGrossPence: orders.totalGrossPence, createdAt: orders.createdAt,
          spec: orders.specificationJson, customer: customers.name, email: customers.email, phone: customers.phone,
        })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .where(and(sql`${teamIdSql} = ${id}`, isNull(orders.removedAt)))
        .orderBy(orders.createdAt),
    )
  ).map((o) => {
    const s = asTeamSpec(o.spec)!;
    return { ...o, lines: s.lines, printedName: s.printedName };
  });
  // Size tally per garment in its own size order; garments or sizes since removed still count.
  const lines = list.flatMap((o) => o.lines.map((l) => ({ ...l, named: Boolean(o.printedName) })));
  const known = row.items.map((i) => ({ id: i.id, product: i.product, colour: i.colour, sizes: i.sizes }));
  for (const l of lines) if (!known.some((k) => k.id === l.itemId)) known.push({ id: l.itemId, product: l.product, colour: '', sizes: [] });
  const items = known.map((k) => {
    const mine = lines.filter((l) => l.itemId === k.id);
    const order = [...k.sizes, ...new Set(mine.map((l) => l.size).filter((s) => !k.sizes.includes(s)))];
    return {
      ...k,
      total: mine.length,
      named: mine.filter((l) => l.named).length,
      sizes: order.map((size) => ({ size, total: mine.filter((l) => l.size === size).length, named: mine.filter((l) => l.size === size && l.named).length })),
    };
  });
  return {
    team: row,
    orders: list,
    items,
    totals: { orders: list.length, garments: lines.length, named: lines.filter((l) => l.named).length, value: list.reduce((n, l) => n + l.totalGrossPence, 0) },
  };
}

export function teamCsv(d: NonNullable<Awaited<ReturnType<typeof teamOrderDetail>>>) {
  const q = (v: string) => (/[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  const lines = [['Order', 'Name', 'Email', 'Phone', 'Garment', 'Size', 'Name on garment', 'Order total', 'Status', 'Ordered on'].join(',')];
  for (const o of d.orders) {
    for (const l of o.lines) {
      lines.push(
        [o.orderNumber, o.customer, o.email, o.phone, l.product, l.size, o.printedName, (o.totalGrossPence / 100).toFixed(2), o.status, o.createdAt.toISOString().slice(0, 10)]
          .map((v) => q(String(v)))
          .join(','),
      );
    }
  }
  lines.push('', 'Garment,Size,Total,With name');
  for (const it of d.items) for (const s of it.sizes) if (s.total) lines.push([q(it.product), q(s.size), s.total, s.named].join(','));
  return lines.join('\n') + '\n';
}

/* ─────────────────────────────── Public link ─────────────────────────────── */

export async function findTeamOrder(token: string): Promise<{ team: TeamOrder; org: Organisation } | null> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const db = systemDb();
  const [team] = await db.select().from(teamOrders).where(eq(teamOrders.token, token)).limit(1);
  if (!team) return null;
  const [org] = await db.select().from(organisations).where(eq(organisations.id, team.organisationId)).limit(1);
  return org ? { team, org } : null;
}

const NAME_CHARS = /^[\p{L}\p{M}0-9 .'’&-]+$/u;
export const nameOffered = (team: Pick<TeamOrder, 'namePricePence' | 'namePlacement'>) => team.namePricePence > 0 || Boolean(team.namePlacement);

/** Form fields: `size_{itemId}` (empty = not wanted), `addName`, `printedName`, `customerName`, `email`, `phone`, `accept`. */
export async function submitTeamOrder(token: string, raw: Record<string, unknown>, meta: { ip: string | null }) {
  const found = await findTeamOrder(token);
  if (!found) throw new ServiceError('This order link isn’t available. Please contact the shop.');
  const { team, org } = found;
  if (!isOpen(team, londonToday())) throw new ServiceError('Orders for this have now closed. Please contact the shop.');

  const schema = z.object({
    addName: z.string().default(''),
    printedName: z.string().trim().max(team.nameMaxLength, `Up to ${team.nameMaxLength} characters`).default(''),
    customerName: z.string().trim().min(2, 'Please enter your name').max(120),
    email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
    phone: t(40),
    accept: z.string().default('').refine((v) => v === 'yes', 'Please tick to accept the order'),
  });
  const res = schema.safeParse(raw);
  const errs: Record<string, string> = res.success ? {} : fieldErrors(res.error.issues);
  const chosen: { item: TeamItem; size: string }[] = [];
  for (const item of team.items) {
    const size = String(raw[`size_${item.id}`] ?? '').trim();
    if (!size) continue;
    if (!item.sizes.includes(size)) errs[`size_${item.id}`] = 'Please choose a size from the list';
    else chosen.push({ item, size });
  }
  if (!chosen.length && !Object.keys(errs).some((k) => k.startsWith('size_'))) errs.items = 'Choose a size for at least one item';
  const wantsName = nameOffered(team) && res.success && res.data.addName === 'yes';
  if (res.success && wantsName) {
    if (!res.data.printedName) errs.printedName = 'Type the name you’d like, or untick the name option';
    else if (!NAME_CHARS.test(res.data.printedName)) errs.printedName = 'Letters, numbers, spaces and . - ’ & only';
  }
  if (!res.success || Object.keys(errs).length) throw new ServiceError('Please check the highlighted fields.', errs);
  const v = res.data;
  const printedName = wantsName ? v.printedName.replace(/\s+/g, ' ') : '';

  // Rate limits: one clubhouse may share an IP, so the per-IP limit is generous.
  const [recent] = await withTenant(org.id, (tx) =>
    tx
      .select({
        link: sql<number>`count(*) filter (where ${auditEvents.newValueJson}->>'teamOrderId' = ${team.id})::int`,
        ip: sql<number>`count(*) filter (where ${auditEvents.metadataJson}->>'ip' = ${meta.ip ?? ''} and ${auditEvents.createdAt} > now() - interval '1 hour')::int`,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, 'team_order_submitted'), gt(auditEvents.createdAt, sql`now() - interval '1 day'`))),
  );
  if ((meta.ip && recent.ip >= TEAM_LIMITS.perIpPerHour) || recent.link >= TEAM_LIMITS.perLinkPerDay) {
    throw new ServiceError('We’ve had a lot of orders in a short time. Please try again later or contact the shop.');
  }

  const namePence = printedName ? team.namePricePence : 0;
  const nameNote = printedName
    ? `Name: ${printedName}${team.namePlacement ? ` (${team.namePlacement.toLowerCase()})` : ''}${team.namePricePence ? `, included +${money(team.namePricePence)}` : ''}`
    : nameOffered(team) ? 'Name: none' : '';
  const each = (c: (typeof chosen)[number]) => c.item.pricePence + namePence;
  const total = chosen.reduce((n, c) => n + each(c), 0);
  const [first, ...rest] = chosen;
  const ctx = await customerDesignCtx(org, v.customerName);
  const spec: TeamSpec = { teamOrderId: team.id, printedName, lines: chosen.map((c) => ({ itemId: c.item.id, product: c.item.product, size: c.size })) };
  const order = await createOrder(
    ctx,
    {
      customerName: v.customerName, email: v.email, phone: v.phone, customerId: '',
      brand: team.brand, category: 'Clothing', product: first.item.product, sku: '', colour: first.item.colour, size: first.size, hand: '', quantity: '1', variant: '',
      ...(rest.length
        ? {
            unitPricePence: (each(first) / 100).toFixed(2),
            extraItems: JSON.stringify(
              rest.map((c) => ({ brand: team.brand, category: 'Clothing', product: c.item.product, colour: c.item.colour, size: c.size, quantity: 1, notes: printedName ? nameNote : '', unitPricePence: (each(c) / 100).toFixed(2) })),
            ),
            specificationText: [nameNote, team.description].filter(Boolean).join('\n'),
          }
        : { totalGrossPence: (total / 100).toFixed(2), specificationText: [nameNote, team.description].filter(Boolean).join('\n') }),
      depositPence: '', creditPence: '', etaDate: '', supplierReference: '',
      internalNotes: `Team order: ${team.title}${team.teamName ? ` (${team.teamName})` : ''}. Accepted online by ${v.customerName}.`,
    },
    { spec: { team: spec } },
  );
  await withTenant(org.id, (tx) =>
    recordEvent(tx, {
      organisationId: org.id, actor: ctx.actor, eventType: 'team_order_submitted', entityType: 'order', orderId: order.id, customerId: order.customerId,
      newValue: { teamOrderId: team.id, lines: spec.lines, printedName: printedName || undefined, totalGrossPence: total, accepted: true },
      metadata: { ip: meta.ip ?? '' },
    }),
  );
  return { order, total, printedName, lines: chosen.map((c) => ({ product: c.item.product, size: c.size })) };
}
