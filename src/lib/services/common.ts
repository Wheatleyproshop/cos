import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { customers, organisations, payments, trackingTokens, type Organisation } from '@/db/schema';
import { recordEvent, type Actor } from '../audit';
import { appUrl, hashToken, newToken } from '../tokens';

export type Role = 'admin' | 'manager' | 'staff';

/** Who is acting, on behalf of which organisation. */
export type Ctx = {
  org: Organisation;
  actor: Actor;
  userId: string | null;
  role: Role | null;
};

const RANK: Record<Role, number> = { staff: 1, manager: 2, admin: 3 };

export function atLeast(ctx: Ctx, min: Role): boolean {
  return ctx.role !== null && RANK[ctx.role] >= RANK[min];
}

/** An error whose message is safe and useful to show to staff. */
export class ServiceError extends Error {
  constructor(
    message: string,
    public fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function requireRole(ctx: Ctx, min: Role, what: string) {
  if (!atLeast(ctx, min)) throw new ServiceError(`Only a ${min === 'admin' ? 'owner/admin' : 'manager or admin'} can ${what}.`);
}

export async function nextNumber(tx: DB, orgId: string, kind: 'order' | 'quote'): Promise<string> {
  const col = kind === 'order' ? organisations.nextOrderNumber : organisations.nextQuoteNumber;
  const [row] = await tx
    .update(organisations)
    .set(kind === 'order' ? { nextOrderNumber: sql`${col} + 1` } : { nextQuoteNumber: sql`${col} + 1` })
    .where(eq(organisations.id, orgId))
    .returning({ n: col, prefix: organisations.orderPrefix });
  const n = row.n - 1;
  return kind === 'order' ? `${row.prefix}-${n}` : `Q-${n}`;
}

export type CustomerInput = { name: string; email: string; phone?: string };

/** Reuses an existing customer by email (case-insensitive) or creates one. */
export async function findOrCreateCustomer(tx: DB, ctx: Ctx, input: CustomerInput) {
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.organisationId, ctx.org.id), sql`lower(${customers.email}) = ${email}`))
    .limit(1);
  if (existing) {
    const phone = input.phone?.trim();
    if (phone && !existing.phone) {
      await tx.update(customers).set({ phone, updatedAt: new Date() }).where(eq(customers.id, existing.id));
      await recordEvent(tx, {
        organisationId: ctx.org.id,
        actor: ctx.actor,
        eventType: 'customer_updated',
        entityType: 'customer',
        customerId: existing.id,
        oldValue: { phone: existing.phone },
        newValue: { phone },
      });
      return { ...existing, phone };
    }
    return existing;
  }
  const [created] = await tx
    .insert(customers)
    .values({ organisationId: ctx.org.id, name: input.name.trim(), email, phone: input.phone?.trim() ?? '' })
    .returning();
  await recordEvent(tx, {
    organisationId: ctx.org.id,
    actor: ctx.actor,
    eventType: 'customer_created',
    entityType: 'customer',
    customerId: created.id,
    newValue: { name: created.name, email: created.email, phone: created.phone },
  });
  return created;
}

/** Issues a fresh read-only tracking link. Only the hash is stored. */
export async function issueTrackingLink(tx: DB, orgId: string, orderId: string): Promise<string> {
  const token = newToken();
  await tx.insert(trackingTokens).values({
    organisationId: orgId,
    orderId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  return appUrl(`/t/${token}`);
}

export async function paidPence(tx: DB, orderId: string): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amountPence} else ${payments.amountPence} end), 0)::int`,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId));
  return Number(row?.total ?? 0);
}
