import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import { brands, prebookLines, prebooks, supplierAccounts } from '@/db/schema';
import { recordEvent } from '../audit';
import { parse } from '../validation';
import { requireRole, ServiceError, type Ctx } from './common';

const text = (max: number) => z.string().trim().max(max).default('');
const email = z
  .string()
  .trim()
  .max(200)
  .default('')
  .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email address');
const url = z
  .string()
  .trim()
  .max(300)
  .default('')
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v))
  .refine((v) => !v || /^https:\/\/[^\s]+$/i.test(v), 'Enter a web address, e.g. https://b2b.example.com');

const accountSchema = z.object({
  brand: z.string().trim().min(1, 'Brand is required').max(80),
  accountNumber: text(80),
  repName: text(120),
  repPhone: text(40),
  repEmail: email,
  headOfficePhone: text(40),
  headOfficeEmail: email,
  ordersEmail: email,
  portalUrl: url,
  portalUsername: text(120),
  paymentTerms: text(200),
  notes: text(2000),
});

/** Accounts with what's currently on pre-book with each brand. */
export async function listAccounts(orgId: string, opts: { includeInactive?: boolean } = {}) {
  return withTenant(orgId, async (tx) => {
    const accounts = await tx
      .select()
      .from(supplierAccounts)
      .where(opts.includeInactive ? undefined : eq(supplierAccounts.active, true))
      .orderBy(asc(supplierAccounts.brand));
    const open = await tx
      .select({
        accountId: prebooks.supplierAccountId,
        brand: prebooks.brand,
        prebooks: sql<number>`count(distinct ${prebooks.id})::int`,
        valuePence: sql<number>`coalesce(sum(${prebookLines.quantity} * ${prebookLines.unitCostPence}), 0)::int`,
      })
      .from(prebooks)
      .leftJoin(prebookLines, and(eq(prebookLines.prebookId, prebooks.id), isNull(prebookLines.removedAt)))
      .where(and(isNull(prebooks.archivedAt), sql`${prebooks.status} not in ('delivered', 'cancelled')`))
      .groupBy(prebooks.supplierAccountId, prebooks.brand);
    return accounts.map((a) => {
      const mine = open.filter((o) => o.accountId === a.id || (!o.accountId && o.brand.toLowerCase() === a.brand.toLowerCase()));
      return { ...a, openPrebooks: mine.reduce((s, o) => s + o.prebooks, 0), openValuePence: mine.reduce((s, o) => s + o.valuePence, 0) };
    });
  });
}

export type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number];

export async function saveAccount(ctx: Ctx, id: string | null, raw: unknown) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  const v = parse(accountSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const dupe = await tx
      .select({ id: supplierAccounts.id })
      .from(supplierAccounts)
      .where(sql`lower(${supplierAccounts.brand}) = ${v.brand.toLowerCase()}`);
    if (dupe.some((d) => d.id !== id)) throw new ServiceError(`There’s already an account for ${v.brand}.`, { brand: 'Already added' });
    let before: Record<string, unknown> | null = null;
    let accountId = id;
    if (id) {
      const [row] = await tx.select().from(supplierAccounts).where(eq(supplierAccounts.id, id));
      if (!row) throw new ServiceError('Account not found.');
      before = row;
      await tx.update(supplierAccounts).set({ ...v, updatedAt: new Date() }).where(eq(supplierAccounts.id, id));
    } else {
      [{ id: accountId }] = await tx.insert(supplierAccounts).values({ organisationId: ctx.org.id, ...v }).returning({ id: supplierAccounts.id });
    }
    const changed = before ? Object.fromEntries(Object.entries(v).filter(([k, val]) => before![k] !== val)) : v;
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'supplier_account', entityId: accountId,
      // Field names only for the old values: the trail shows what changed without duplicating every contact detail.
      oldValue: before ? { fields: Object.keys(changed) } : null, newValue: { brand: v.brand, ...(before ? { fields: Object.keys(changed) } : {}) },
    });
  });
}

export async function setAccountActive(ctx: Ctx, id: string, active: boolean) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(supplierAccounts).set({ active, updatedAt: new Date() }).where(eq(supplierAccounts.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'supplier_account', entityId: id,
      newValue: { active },
    });
  });
}

/** One empty account card per catalogue brand that doesn't have one yet. */
export async function addAccountsForCatalogueBrands(ctx: Ctx) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  return withTenant(ctx.org.id, async (tx) => {
    const have = new Set((await tx.select({ brand: supplierAccounts.brand }).from(supplierAccounts)).map((a) => a.brand.toLowerCase()));
    const missing = (await tx.select({ name: brands.name }).from(brands).where(eq(brands.active, true))).filter((b) => !have.has(b.name.toLowerCase()));
    if (!missing.length) return 0;
    await tx.insert(supplierAccounts).values(missing.map((b) => ({ organisationId: ctx.org.id, brand: b.name })));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { added: missing.map((b) => b.name) },
    });
    return missing.length;
  });
}
