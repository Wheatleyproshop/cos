import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type DB } from '@/db';
import { organisations, prebookLines, prebooks, supplierAccounts, type Prebook, type PrebookLine, type PrebookStatus } from '@/db/schema';
import { recordEvent } from '../audit';
import { parseMoneyToPence, todayInTz } from '../format';
import { parse } from '../validation';
import { requireRole, ServiceError, type Ctx } from './common';

/**
 * Pre-books: seasonal stock orders placed with a brand for future delivery. Managers create and
 * place them; any staff member can book in what arrives. Nothing is deleted: pre-books are
 * cancelled or archived, lines are marked removed.
 */

export const PREBOOK_STATUS_LABELS: Record<PrebookStatus, string> = {
  draft: 'Draft',
  placed: 'Placed',
  confirmed: 'Confirmed',
  part_delivered: 'Part delivered',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const isoDate = z
  .string()
  .trim()
  .default('')
  .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a date')
  .transform((v) => v || null);

const detailsSchema = z
  .object({
    supplierAccountId: z.union([z.literal(''), z.string().uuid()]).default('').transform((v) => v || null),
    brand: z.string().trim().max(80).default(''),
    season: z.string().trim().max(40).default(''),
    title: z.string().trim().max(160).default(''),
    supplierReference: z.string().trim().max(120).default(''),
    expectedFrom: isoDate,
    expectedTo: isoDate,
    notes: z.string().trim().max(4000).default(''),
  })
  .refine((v) => !v.expectedFrom || !v.expectedTo || v.expectedFrom <= v.expectedTo, {
    message: 'The delivery window ends before it starts',
    path: ['expectedTo'],
  });

const lineSchema = z.object({
  product: z.string().trim().min(1, 'Product is required').max(160),
  sku: z.string().trim().max(80).default(''),
  variant: z.string().trim().max(160).default(''),
  quantity: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(10000),
  unitCostPence: z.string().default('0').transform((v, c) => {
    const p = parseMoneyToPence(v || '0');
    if (p === null || p < 0) {
      c.addIssue({ code: 'custom', message: 'Enter a cost like 249.00' });
      return z.NEVER;
    }
    return p;
  }),
  expectedDate: isoDate,
  forCustomer: z.string().trim().max(160).default(''),
});

export type PrebookSummary = Prebook & {
  accountNumber: string | null;
  lines: number;
  quantity: number;
  received: number;
  valuePence: number;
  receivedValuePence: number;
};

const totals = {
  lines: sql<number>`count(${prebookLines.id})::int`,
  quantity: sql<number>`coalesce(sum(${prebookLines.quantity}), 0)::int`,
  received: sql<number>`coalesce(sum(least(${prebookLines.quantityReceived}, ${prebookLines.quantity})), 0)::int`,
  valuePence: sql<number>`coalesce(sum(${prebookLines.quantity} * ${prebookLines.unitCostPence}), 0)::int`,
  receivedValuePence: sql<number>`coalesce(sum(least(${prebookLines.quantityReceived}, ${prebookLines.quantity}) * ${prebookLines.unitCostPence}), 0)::int`,
};

export async function listPrebooks(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<PrebookSummary[]> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ p: prebooks, accountNumber: supplierAccounts.accountNumber, ...totals })
      .from(prebooks)
      .leftJoin(supplierAccounts, eq(supplierAccounts.id, prebooks.supplierAccountId))
      .leftJoin(prebookLines, and(eq(prebookLines.prebookId, prebooks.id), isNull(prebookLines.removedAt)))
      .where(opts.includeArchived ? undefined : isNull(prebooks.archivedAt))
      .groupBy(prebooks.id, supplierAccounts.accountNumber)
      .orderBy(asc(sql`coalesce(${prebooks.expectedFrom}, '9999-12-31')`), desc(prebooks.createdAt));
    return rows.map(({ p, ...t }) => ({ ...p, ...t }));
  });
}

/** Lines still to arrive, for the "arriving soon" and month-by-month views. */
export async function upcomingLines(orgId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ line: prebookLines, prebook: prebooks })
      .from(prebookLines)
      .innerJoin(prebooks, eq(prebooks.id, prebookLines.prebookId))
      .where(
        and(
          isNull(prebookLines.removedAt),
          isNull(prebooks.archivedAt),
          sql`${prebooks.status} not in ('draft', 'cancelled', 'delivered')`,
          sql`${prebookLines.quantityReceived} < ${prebookLines.quantity}`,
        ),
      ),
  );
}

export async function getPrebook(orgId: string, reference: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ p: prebooks, account: supplierAccounts })
      .from(prebooks)
      .leftJoin(supplierAccounts, eq(supplierAccounts.id, prebooks.supplierAccountId))
      .where(eq(prebooks.reference, reference))
      .limit(1);
    if (!row) return null;
    const lines = await tx
      .select()
      .from(prebookLines)
      .where(and(eq(prebookLines.prebookId, row.p.id), isNull(prebookLines.removedAt)))
      .orderBy(asc(sql`coalesce(${prebookLines.expectedDate}, '9999-12-31')`), asc(prebookLines.createdAt));
    return { prebook: row.p, account: row.account, lines };
  });
}

async function load(tx: DB, ctx: Ctx, id: string) {
  const [p] = await tx.select().from(prebooks).where(and(eq(prebooks.id, id), eq(prebooks.organisationId, ctx.org.id))).for('update').limit(1);
  if (!p) throw new ServiceError('Pre-book not found.');
  return p;
}

async function resolveBrand(tx: DB, accountId: string | null, brand: string) {
  if (accountId) {
    const [a] = await tx.select().from(supplierAccounts).where(eq(supplierAccounts.id, accountId));
    if (!a) throw new ServiceError('That account no longer exists.', { supplierAccountId: 'Choose another' });
    return a.brand;
  }
  if (!brand) throw new ServiceError('Choose the brand account or type a brand.', { supplierAccountId: 'Required' });
  return brand;
}

export async function createPrebook(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'create pre-books');
  if (!ctx.userId) throw new ServiceError('Sign in to create a pre-book.');
  const v = parse(detailsSchema, raw);
  return withTenant(ctx.org.id, async (tx) => {
    const brand = await resolveBrand(tx, v.supplierAccountId, v.brand);
    const [{ n }] = await tx
      .update(organisations)
      .set({ nextPrebookNumber: sql`${organisations.nextPrebookNumber} + 1` })
      .where(eq(organisations.id, ctx.org.id))
      .returning({ n: organisations.nextPrebookNumber });
    const [p] = await tx
      .insert(prebooks)
      .values({ organisationId: ctx.org.id, reference: `PB-${n - 1}`, ...v, brand, createdByUserId: ctx.userId! })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_created', entityType: 'prebook', entityId: p.id,
      newValue: { reference: p.reference, brand, season: v.season },
    });
    return p;
  });
}

export async function updatePrebook(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit pre-books');
  const v = parse(detailsSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const p = await load(tx, ctx, id);
    const brand = await resolveBrand(tx, v.supplierAccountId, v.brand || p.brand);
    const next = { ...v, brand };
    const changed = Object.fromEntries(Object.entries(next).filter(([k, val]) => (p as Record<string, unknown>)[k] !== val));
    if (!Object.keys(changed).length) return;
    await tx.update(prebooks).set({ ...changed, updatedAt: new Date() }).where(eq(prebooks.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_updated', entityType: 'prebook', entityId: id,
      oldValue: Object.fromEntries(Object.keys(changed).map((k) => [k, (p as Record<string, unknown>)[k]])), newValue: changed,
    });
  });
}

export async function addLine(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit pre-books');
  const v = parse(lineSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const p = await load(tx, ctx, id);
    if (p.status === 'cancelled' || p.status === 'delivered') throw new ServiceError(`This pre-book is ${PREBOOK_STATUS_LABELS[p.status].toLowerCase()}.`);
    await tx.insert(prebookLines).values({ organisationId: ctx.org.id, prebookId: id, ...v });
    await tx.update(prebooks).set({ updatedAt: new Date() }).where(eq(prebooks.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_line_added', entityType: 'prebook', entityId: id,
      newValue: { product: v.product, variant: v.variant, quantity: v.quantity, unitCostPence: v.unitCostPence },
    });
  });
}

export async function removeLine(ctx: Ctx, id: string, lineId: string) {
  requireRole(ctx, 'manager', 'edit pre-books');
  await withTenant(ctx.org.id, async (tx) => {
    await load(tx, ctx, id);
    const [line] = await tx.select().from(prebookLines).where(and(eq(prebookLines.id, lineId), eq(prebookLines.prebookId, id)));
    if (!line) throw new ServiceError('Line not found.');
    if (line.quantityReceived > 0) throw new ServiceError('Part of this line has already arrived, so it can’t be removed.');
    await tx.update(prebookLines).set({ removedAt: new Date() }).where(eq(prebookLines.id, lineId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_line_removed', entityType: 'prebook', entityId: id,
      oldValue: { product: line.product, variant: line.variant, quantity: line.quantity },
    });
  });
}

/** Placed, confirmed, cancelled, back to draft. Delivery states come from booking stock in. */
export async function setPrebookStatus(ctx: Ctx, id: string, status: 'draft' | 'placed' | 'confirmed' | 'cancelled') {
  requireRole(ctx, 'manager', 'change pre-books');
  await withTenant(ctx.org.id, async (tx) => {
    const p = await load(tx, ctx, id);
    if (p.status === status) return;
    if (['part_delivered', 'delivered'].includes(p.status) && status !== 'cancelled') {
      throw new ServiceError('Stock has already arrived on this pre-book.');
    }
    if (status === 'placed' || status === 'confirmed') {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(prebookLines)
        .where(and(eq(prebookLines.prebookId, id), isNull(prebookLines.removedAt)));
      if (!n) throw new ServiceError('Add at least one line before placing the pre-book.');
    }
    const placedOn = status === 'placed' && !p.placedOn ? todayInTz(ctx.org.timezone) : p.placedOn;
    await tx.update(prebooks).set({ status, placedOn, updatedAt: new Date() }).where(eq(prebooks.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_status_changed', entityType: 'prebook', entityId: id,
      oldValue: { status: p.status }, newValue: { status },
    });
  });
}

/**
 * Books in what has arrived (running totals per line). The pre-book becomes Part delivered or
 * Delivered automatically.
 */
export async function receiveStock(ctx: Ctx, id: string, received: Record<string, number>) {
  return withTenant(ctx.org.id, async (tx) => {
    const p = await load(tx, ctx, id);
    if (p.status === 'draft' || p.status === 'cancelled') throw new ServiceError('Place the pre-book before booking stock in.');
    const lines: PrebookLine[] = await tx.select().from(prebookLines).where(and(eq(prebookLines.prebookId, id), isNull(prebookLines.removedAt)));
    const changes: { product: string; from: number; to: number }[] = [];
    for (const l of lines) {
      if (!(l.id in received)) continue;
      const to = Math.trunc(received[l.id]);
      if (!Number.isFinite(to) || to < 0 || to > l.quantity) {
        throw new ServiceError(`${l.product}: received must be between 0 and ${l.quantity}.`);
      }
      if (to !== l.quantityReceived) {
        await tx.update(prebookLines).set({ quantityReceived: to }).where(eq(prebookLines.id, l.id));
        changes.push({ product: [l.product, l.variant].filter(Boolean).join(' — '), from: l.quantityReceived, to });
        l.quantityReceived = to;
      }
    }
    if (!changes.length) return p.status;
    const total = lines.reduce((s, l) => s + l.quantity, 0);
    const got = lines.reduce((s, l) => s + l.quantityReceived, 0);
    const status: PrebookStatus = got >= total ? 'delivered' : got > 0 ? 'part_delivered' : p.status === 'part_delivered' ? 'confirmed' : p.status;
    await tx.update(prebooks).set({ status, updatedAt: new Date() }).where(eq(prebooks.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_received', entityType: 'prebook', entityId: id,
      oldValue: { status: p.status }, newValue: { status, lines: changes },
    });
    return status;
  });
}

export async function archivePrebook(ctx: Ctx, id: string, archived: boolean) {
  requireRole(ctx, 'manager', 'archive pre-books');
  await withTenant(ctx.org.id, async (tx) => {
    await load(tx, ctx, id);
    await tx.update(prebooks).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(prebooks.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'prebook_updated', entityType: 'prebook', entityId: id,
      newValue: { archived },
    });
  });
}
