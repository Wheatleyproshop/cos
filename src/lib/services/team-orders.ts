import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemDb, withTenant } from '@/db';
import { auditEvents, customers, organisations, orders, teamOrders, type Organisation, type TeamOrder } from '@/db/schema';
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
 * Team-wear order links: a club team picks one garment at a set price (crest included); each member
 * opens the link, chooses their size and whether to add their name (extra charge), and accepts the
 * order. Every response is a normal COS order ("To place"), so it shows on the order board, the
 * supplier sheets and in the customer's emails like any other.
 */

export type TeamSpec = { kind: 'cos-team'; version: 1; teamOrderId: string; size: string; printedName: string };
export const asTeamSpec = (json: unknown): TeamSpec | null => ((json as TeamSpec | null)?.kind === 'cos-team' ? (json as TeamSpec) : null);

export const TEAM_LIMITS = { perIpPerHour: 30, perLinkPerDay: 300 };
export const DEFAULT_TEAM_TERMS =
  'By placing this order you’re agreeing to buy this item at the price shown. It’s ordered in especially for you, so it can’t be returned or exchanged unless it’s faulty — please check the size before you order. Payment is due when you collect.';
export const MAX_TEAM_IMAGE_BYTES = 4 * 1024 * 1024;

const t = (n: number) => z.string().trim().max(n, `Keep this under ${n} characters`).default('');
const pounds = (label: string, optional = false) =>
  z
    .string()
    .trim()
    .default('')
    .transform((v, ctx) => {
      if (!v && optional) return 0;
      const p = parseMoneyToPence(v);
      if (p === null || p < 0 || p > 1_000_000) {
        ctx.addIssue({ code: 'custom', message: `${label}: enter an amount, e.g. 49.99` });
        return z.NEVER;
      }
      return p;
    });

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
  product: z.string().trim().min(2, 'Which product?').max(160),
  colour: t(60),
  description: t(1000),
  sizes: z
    .string()
    .default('')
    .transform((v, ctx) => {
      const s = parseSizes(v);
      if (!s.length) {
        ctx.addIssue({ code: 'custom', message: 'List the sizes, separated by commas' });
        return z.NEVER;
      }
      return s;
    }),
  price: pounds('Price'),
  namePrice: pounds('Name price', true),
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

async function storeImage(ctx: Ctx, file: File | null) {
  const img = await readImage(file, 'photo', MAX_TEAM_IMAGE_BYTES);
  if (!img) return null;
  const key = `orgs/${ctx.org.id}/team-orders/${newToken().slice(0, 16)}.${LOGO_TYPES[img.mime]}`;
  await storage().put(key, img.buf, img.mime);
  return { imageKey: key, imageMime: img.mime };
}

/** Creates the link (manager or admin). */
export async function createTeamOrder(ctx: Ctx, raw: unknown, image: File | null) {
  requireRole(ctx, 'manager', 'set up team orders');
  const res = setupSchema.safeParse(raw);
  if (!res.success) throw new ServiceError('Please check the highlighted fields.', fieldErrors(res.error.issues));
  const v = res.data;
  const img = await storeImage(ctx, image);
  return withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .insert(teamOrders)
      .values({
        organisationId: ctx.org.id, token: newToken().slice(0, 22), title: v.title, teamName: v.teamName, brand: v.brand, product: v.product, colour: v.colour,
        description: v.description, sizes: v.sizes, pricePence: v.price, namePricePence: v.namePrice, namePlacement: v.namePlacement, nameMaxLength: v.nameMaxLength,
        terms: v.terms || DEFAULT_TEAM_TERMS, closesOn: v.closesOn, createdByUserId: ctx.userId!, ...(img ?? {}),
      })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'team_order_created', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { teamOrderId: row.id, title: row.title, pricePence: row.pricePence, namePricePence: row.namePricePence },
    });
    return row;
  });
}

/** Edits the link's details. Orders already placed keep the price they were placed at. */
export async function updateTeamOrder(ctx: Ctx, id: string, raw: unknown, image: File | null) {
  requireRole(ctx, 'manager', 'change team orders');
  const res = setupSchema.safeParse(raw);
  if (!res.success) throw new ServiceError('Please check the highlighted fields.', fieldErrors(res.error.issues));
  const v = res.data;
  const img = await storeImage(ctx, image);
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .update(teamOrders)
      .set({
        title: v.title, teamName: v.teamName, brand: v.brand, product: v.product, colour: v.colour, description: v.description, sizes: v.sizes,
        pricePence: v.price, namePricePence: v.namePrice, namePlacement: v.namePlacement, nameMaxLength: v.nameMaxLength,
        terms: v.terms || DEFAULT_TEAM_TERMS, closesOn: v.closesOn, ...(img ?? {}),
      })
      .where(eq(teamOrders.id, id))
      .returning({ id: teamOrders.id });
    if (!row) throw new ServiceError('Team order not found.');
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'team_order_changed', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { teamOrderId: id, title: v.title, pricePence: v.price, namePricePence: v.namePrice, closesOn: v.closesOn },
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

/** Orders placed through one link (not deleted). */
async function linkOrders(orgId: string, teamOrderId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({
        id: orders.id, orderNumber: orders.orderNumber, status: orders.status, totalGrossPence: orders.totalGrossPence, createdAt: orders.createdAt,
        spec: orders.specificationJson, customer: customers.name, email: customers.email, phone: customers.phone,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(sql`${orders.specificationJson}->>'kind' = 'cos-team'`, sql`${orders.specificationJson}->>'teamOrderId' = ${teamOrderId}`, isNull(orders.removedAt)))
      .orderBy(orders.createdAt),
  );
}

export async function listTeamOrders(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(teamOrders).orderBy(desc(teamOrders.createdAt)).limit(100);
    const counts = await tx
      .select({ id: sql<string>`${orders.specificationJson}->>'teamOrderId'`, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${orders.totalGrossPence}), 0)::int` })
      .from(orders)
      .where(and(sql`${orders.specificationJson}->>'kind' = 'cos-team'`, isNull(orders.removedAt)))
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
  const list = (await linkOrders(orgId, id)).map((o) => {
    const s = asTeamSpec(o.spec)!;
    return { ...o, size: s.size, printedName: s.printedName };
  });
  // Size tally in the link's own size order; sizes since removed from the list still count.
  const order = [...row.sizes, ...new Set(list.map((l) => l.size).filter((s) => !row.sizes.includes(s)))];
  const sizes = order.map((size) => ({
    size,
    total: list.filter((l) => l.size === size).length,
    named: list.filter((l) => l.size === size && l.printedName).length,
  }));
  return {
    team: row,
    orders: list,
    sizes,
    totals: { count: list.length, named: list.filter((l) => l.printedName).length, value: list.reduce((n, l) => n + l.totalGrossPence, 0) },
  };
}

export function teamCsv(d: NonNullable<Awaited<ReturnType<typeof teamOrderDetail>>>) {
  const q = (v: string) => (/[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);
  const lines = [['Order', 'Name', 'Email', 'Phone', 'Size', 'Name on garment', 'Price', 'Status', 'Ordered on'].join(',')];
  for (const o of d.orders) {
    lines.push(
      [o.orderNumber, o.customer, o.email, o.phone, o.size, o.printedName, (o.totalGrossPence / 100).toFixed(2), o.status, o.createdAt.toISOString().slice(0, 10)]
        .map((v) => q(String(v)))
        .join(','),
    );
  }
  lines.push('', 'Size,Total,With name');
  for (const s of d.sizes) if (s.total) lines.push([q(s.size), s.total, s.named].join(','));
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

export async function submitTeamOrder(token: string, raw: Record<string, unknown>, meta: { ip: string | null }) {
  const found = await findTeamOrder(token);
  if (!found) throw new ServiceError('This order link isn’t available. Please contact the shop.');
  const { team, org } = found;
  if (!isOpen(team, londonToday())) throw new ServiceError('Orders for this have now closed. Please contact the shop.');

  const nameOffered = team.namePricePence > 0 || Boolean(team.namePlacement);
  const schema = z.object({
    size: z.string().refine((s) => team.sizes.includes(s), 'Please choose your size'),
    addName: z.string().default(''),
    printedName: z.string().trim().max(team.nameMaxLength, `Up to ${team.nameMaxLength} characters`).default(''),
    customerName: z.string().trim().min(2, 'Please enter your name').max(120),
    email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
    phone: t(40),
    accept: z.string().refine((v) => v === 'yes', 'Please tick to accept the order'),
  });
  const res = schema.safeParse(raw);
  const errs = res.success ? {} : fieldErrors(res.error.issues);
  const wantsName = nameOffered && res.data?.addName === 'yes';
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

  const total = team.pricePence + (printedName ? team.namePricePence : 0);
  const nameLine = printedName
    ? `Name: ${printedName}${team.namePlacement ? ` (${team.namePlacement.toLowerCase()})` : ''}${team.namePricePence ? ` +${money(team.namePricePence)}` : ''}`
    : nameOffered ? 'Name: none' : '';
  const notes = [nameLine, team.description].filter(Boolean).join('\n');
  const ctx = await customerDesignCtx(org, v.customerName);
  const spec: TeamSpec = { kind: 'cos-team', version: 1, teamOrderId: team.id, size: v.size, printedName };
  const order = await createOrder(
    ctx,
    {
      customerName: v.customerName, email: v.email, phone: v.phone, customerId: '',
      brand: team.brand, category: 'Clothing', product: team.product, sku: '', colour: team.colour, size: v.size, hand: '', quantity: '1', variant: '',
      specificationText: notes, totalGrossPence: (total / 100).toFixed(2), depositPence: '', creditPence: '', etaDate: '', supplierReference: '',
      internalNotes: `Team order: ${team.title}${team.teamName ? ` (${team.teamName})` : ''}. Accepted online by ${v.customerName}.`,
    },
    { spec },
  );
  await withTenant(org.id, (tx) =>
    recordEvent(tx, {
      organisationId: org.id, actor: ctx.actor, eventType: 'team_order_submitted', entityType: 'order', orderId: order.id, customerId: order.customerId,
      newValue: { teamOrderId: team.id, size: v.size, printedName: printedName || undefined, totalGrossPence: total, accepted: true },
      metadata: { ip: meta.ip ?? '' },
    }),
  );
  return { order, total, printedName, size: v.size };
}
