import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import { auditEvents, brands, prebookLines, prebooks, supplierAccounts } from '@/db/schema';
import { recordEvent } from '../audit';
import { LOGO_TYPES, MAX_LOGO_BYTES, sniffImage } from '../ball-print';
import { storage } from '../storage';
import { newToken } from '../tokens';
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
      .where(and(isNull(supplierAccounts.removedAt), opts.includeInactive ? undefined : eq(supplierAccounts.active, true)))
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
      .where(and(isNull(prebooks.archivedAt), isNull(prebooks.removedAt), sql`${prebooks.status} not in ('delivered', 'cancelled')`))
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
      .select({ id: supplierAccounts.id, removedAt: supplierAccounts.removedAt })
      .from(supplierAccounts)
      .where(sql`lower(${supplierAccounts.brand}) = ${v.brand.toLowerCase()}`);
    const other = dupe.find((d) => d.id !== id);
    if (other?.removedAt) {
      throw new ServiceError(`There’s a deleted account for ${v.brand}. Restore it from Deleted accounts instead.`, { brand: 'Restore the deleted one' });
    }
    if (other) throw new ServiceError(`There’s already an account for ${v.brand}.`, { brand: 'Already added' });
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

/** Deletes an account card (or restores it). Nothing is erased; pre-books keep their brand and details. */
export async function setAccountDeleted(ctx: Ctx, id: string, deleted: boolean) {
  requireRole(ctx, 'manager', 'delete supplier accounts');
  await withTenant(ctx.org.id, async (tx) => {
    const [a] = await tx.select().from(supplierAccounts).where(and(eq(supplierAccounts.id, id), eq(supplierAccounts.organisationId, ctx.org.id))).limit(1);
    if (!a) throw new ServiceError('Account not found.');
    if (Boolean(a.removedAt) === deleted) return;
    await tx
      .update(supplierAccounts)
      .set(deleted ? { removedAt: new Date(), updatedAt: new Date() } : { removedAt: null, active: true, updatedAt: new Date() })
      .where(eq(supplierAccounts.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'supplier_account', entityId: id,
      newValue: { brand: a.brand, deleted },
    });
  });
}

export async function listDeletedAccounts(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(supplierAccounts).where(isNotNull(supplierAccounts.removedAt)).orderBy(desc(supplierAccounts.removedAt)));
}

/** Edit or delete (empty) an account's notes. The previous text stays in the audit trail. */
export async function updateAccountNotes(ctx: Ctx, id: string, rawNotes: unknown, opts: { restored?: boolean } = {}) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  const notes = String(rawNotes ?? '').trim().slice(0, 2000);
  await withTenant(ctx.org.id, async (tx) => {
    const [a] = await tx.select().from(supplierAccounts).where(and(eq(supplierAccounts.id, id), isNull(supplierAccounts.removedAt))).limit(1);
    if (!a) throw new ServiceError('Account not found.');
    if (notes === a.notes) return;
    await tx.update(supplierAccounts).set({ notes, updatedAt: new Date() }).where(eq(supplierAccounts.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'account_notes_changed', entityType: 'supplier_account', entityId: id,
      oldValue: { notes: a.notes }, newValue: { notes, brand: a.brand, ...(opts.restored ? { restored: true } : {}) },
    });
  });
}

/** Accounts whose notes were just deleted, with the text that can be put back. */
export async function deletedAccountNotes(orgId: string): Promise<Map<string, string>> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ id: auditEvents.entityId, o: auditEvents.oldValueJson, n: auditEvents.newValueJson, at: auditEvents.createdAt })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'account_notes_changed'))
      .orderBy(desc(auditEvents.createdAt));
    const out = new Map<string, string>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const was = (r.o as { notes?: string } | null)?.notes ?? '';
      const now = (r.n as { notes?: string } | null)?.notes ?? '';
      if (!now && was) out.set(r.id, was);
    }
    return out;
  });
}

export async function restoreAccountNotes(ctx: Ctx, id: string) {
  const previous = (await deletedAccountNotes(ctx.org.id)).get(id);
  if (!previous) throw new ServiceError('There are no deleted notes to restore.');
  await updateAccountNotes(ctx, id, previous, { restored: true });
}

/** One empty account card per catalogue brand that doesn't have one yet (a deleted card counts: it isn't re-added). */
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

/** Stores a brand logo for an account (PNG, JPG or WebP; the file's real type is checked). */
export async function setAccountLogo(ctx: Ctx, id: string, file: File | null) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  if (!file || !file.size) throw new ServiceError('Choose a logo image.', { logo: 'Required' });
  if (file.size > MAX_LOGO_BYTES) throw new ServiceError('The logo must be 3 MB or smaller.');
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImage(buf);
  if (!mime || !LOGO_TYPES[mime]) throw new ServiceError('The logo must be a PNG, JPG or WebP image.');
  const [account] = await withTenant(ctx.org.id, (tx) => tx.select().from(supplierAccounts).where(eq(supplierAccounts.id, id)).limit(1));
  if (!account) throw new ServiceError('Account not found.');
  const key = `orgs/${ctx.org.id}/account-logos/${id}-${newToken().slice(0, 10)}.${LOGO_TYPES[mime]}`;
  await storage().put(key, buf, mime);
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(supplierAccounts).set({ logoKey: key, logoMime: mime, updatedAt: new Date() }).where(eq(supplierAccounts.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'supplier_account', entityId: id,
      newValue: { brand: account.brand, logo: account.logoKey ? 'replaced' : 'added' },
    });
  });
}

export async function clearAccountLogo(ctx: Ctx, id: string) {
  requireRole(ctx, 'manager', 'edit supplier accounts');
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(supplierAccounts).set({ logoKey: null, logoMime: null, updatedAt: new Date() }).where(eq(supplierAccounts.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'supplier_account_saved', entityType: 'supplier_account', entityId: id,
      newValue: { logo: 'removed' },
    });
  });
}

/** Cache-busting URL for an account's logo (staff-only route), or null. */
export function accountLogoUrl(a: { id: string; logoKey: string | null }) {
  return a.logoKey ? `/api/account-logo/${a.id}?v=${a.logoKey.slice(-14)}` : null;
}
