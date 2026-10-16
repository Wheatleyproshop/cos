import { and, eq, ne, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { withTenant } from '@/db';
import { customers, organisations, users, type EmailAutomationKey, type EmailAutomations } from '@/db/schema';
import { recordEvent } from '../audit';
import { checkSenderDomain } from '../email/sender';
import { PLANS } from '../plans';
import {
  customerEditSchema,
  parse,
  passwordChangeSchema,
  storeSettingsSchema,
  thresholdsSchema,
  userCreateSchema,
} from '../validation';
import { requireRole, ServiceError, type Ctx } from './common';

/* ─────────────────────────────── Customers ─────────────────────────────── */

export async function updateCustomer(ctx: Ctx, customerId: string, raw: unknown) {
  const input = parse(customerEditSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, customerId)).for('update').limit(1);
    if (!c) throw new ServiceError('Customer not found.');
    if (input.email !== c.email.toLowerCase()) {
      const [clash] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(sql`lower(${customers.email}) = ${input.email}`, ne(customers.id, customerId)))
        .limit(1);
      if (clash) throw new ServiceError('Another customer already uses that email.', { email: 'Already in use' });
    }
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, unknown> = {};
    for (const k of ['name', 'email', 'phone', 'notes'] as const) {
      if (input[k] !== c[k]) {
        oldV[k] = c[k];
        newV[k] = input[k];
      }
    }
    if (!Object.keys(newV).length) return;
    await tx.update(customers).set({ ...newV, updatedAt: new Date() }).where(eq(customers.id, customerId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'customer_updated',
      entityType: 'customer',
      customerId,
      oldValue: oldV,
      newValue: newV,
    });
  });
}

/* ──────────────────────────────── Settings ─────────────────────────────── */

async function updateOrg(ctx: Ctx, section: string, patch: Record<string, unknown>) {
  await withTenant(ctx.org.id, async (tx) => {
    const [org] = await tx.select().from(organisations).where(eq(organisations.id, ctx.org.id)).limit(1);
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const before = (org as Record<string, unknown>)[k];
      if (JSON.stringify(before) !== JSON.stringify(v)) {
        oldV[k] = before;
        newV[k] = v;
      }
    }
    if (!Object.keys(newV).length) return;
    await tx.update(organisations).set(newV).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'settings_changed',
      entityType: 'organisation',
      entityId: ctx.org.id,
      oldValue: oldV,
      newValue: newV,
      metadata: { section },
    });
  });
}

export async function updateStoreSettings(ctx: Ctx, raw: unknown): Promise<string> {
  requireRole(ctx, 'admin', 'change store settings');
  const input = parse(storeSettingsSchema, raw);
  const changed = input.senderEmail !== ctx.org.senderEmail;
  const check = input.senderEmail && changed ? await checkSenderDomain(input.senderEmail) : null;
  await updateOrg(ctx, 'store', {
    ...input,
    ...(changed ? { senderVerifiedAt: check?.verified ? new Date() : null } : {}),
  });
  if (!check) return 'Store identity saved. Customer emails and pages now use these details.';
  return check.verified
    ? `Saved. Customer emails will now come from ${input.senderEmail}.`
    : `Saved, but ${check.detail} Until then emails come from the COS address.`;
}

/** Re-checks the retailer's sending domain (e.g. after DNS records were added). */
export async function recheckSender(ctx: Ctx): Promise<string> {
  requireRole(ctx, 'admin', 'change store settings');
  if (!ctx.org.senderEmail) return 'No custom sending address is set.';
  const check = await checkSenderDomain(ctx.org.senderEmail);
  await updateOrg(ctx, 'store', { senderVerifiedAt: check.verified ? (ctx.org.senderVerifiedAt ?? new Date()) : null });
  return check.verified ? `${ctx.org.senderEmail} is verified — customer emails now come from it.` : check.detail;
}

export async function updateAutomations(ctx: Ctx, enabled: Partial<Record<EmailAutomationKey, boolean>>) {
  requireRole(ctx, 'admin', 'change email automations');
  const next: EmailAutomations = {
    order_confirmation: Boolean(enabled.order_confirmation),
    quote_approval: Boolean(enabled.quote_approval),
    eta_revised: Boolean(enabled.eta_revised),
    ready_for_collection: Boolean(enabled.ready_for_collection),
    collection_reminder: Boolean(enabled.collection_reminder),
  };
  await updateOrg(ctx, 'automations', { emailAutomations: next });
}

export async function updateThresholds(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'admin', 'change attention settings');
  await updateOrg(ctx, 'attention', parse(thresholdsSchema, raw));
}

/* ────────────────────────────────── Team ───────────────────────────────── */

export async function createUser(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'admin', 'add team members');
  const input = parse(userCreateSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.active, true));
    if (count >= PLANS[ctx.org.plan].staffLimit) {
      throw new ServiceError(`Your ${PLANS[ctx.org.plan].label} plan includes ${PLANS[ctx.org.plan].staffLimit} active staff accounts.`);
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    let created;
    try {
      [created] = await tx
        .insert(users)
        .values({ organisationId: ctx.org.id, name: input.name, email: input.email, role: input.role, passwordHash })
        .returning();
    } catch {
      throw new ServiceError('That email address already has a COS account.', { email: 'Already in use' });
    }
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'user_created',
      entityType: 'user',
      entityId: created.id,
      newValue: { name: created.name, email: created.email, role: created.role },
    });
  });
}

/** Role / active changes. Accounts are deactivated, never deleted, so audit history keeps its actors. */
export async function updateUser(ctx: Ctx, userId: string, patch: { role?: 'admin' | 'manager' | 'staff'; active?: boolean }) {
  requireRole(ctx, 'admin', 'manage team members');
  if (userId === ctx.userId && (patch.active === false || (patch.role && patch.role !== 'admin'))) {
    throw new ServiceError('You cannot remove your own admin access. Ask another admin.');
  }
  await withTenant(ctx.org.id, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new ServiceError('Team member not found.');
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, unknown> = {};
    if (patch.role && patch.role !== u.role) {
      oldV.role = u.role;
      newV.role = patch.role;
    }
    if (patch.active !== undefined && patch.active !== u.active) {
      oldV.active = u.active;
      newV.active = patch.active;
    }
    if (!Object.keys(newV).length) return;
    await tx.update(users).set(newV).where(eq(users.id, userId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'user_updated',
      entityType: 'user',
      entityId: userId,
      oldValue: oldV,
      newValue: newV,
    });
  });
}

export async function changeOwnPassword(ctx: Ctx, raw: unknown) {
  const input = parse(passwordChangeSchema, raw);
  if (!ctx.userId) throw new ServiceError('Sign in first.');
  await withTenant(ctx.org.id, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.userId!)).limit(1);
    if (!u || !(await bcrypt.compare(input.current, u.passwordHash))) {
      throw new ServiceError('Your current password is incorrect.', { current: 'Incorrect password' });
    }
    await tx.update(users).set({ passwordHash: await bcrypt.hash(input.next, 12) }).where(eq(users.id, u.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'user_updated',
      entityType: 'user',
      entityId: u.id,
      newValue: { password: 'changed' },
    });
  });
}
