import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type DB } from '@/db';
import type { Organisation } from '@/db/schema';
import {
  auditEvents, customers, messages, organisations, trackingTokens, users, workshopItems, workshopJobs,
  type Customer, type WorkshopItem, type WorkshopJob, type WorkshopStatus,
} from '@/db/schema';
import { recordEvent, SYSTEM } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import type { FitSpec } from '../fit-spec';
import { money, parseMoneyToPence } from '../format';
import { appUrl, hashToken, newToken } from '../tokens';
import { customerFields, parse } from '../validation';
import { WORKSHOP_STATUS_LABELS } from '../workshop-constants';
import { atLeast, findOrCreateCustomer, requireRole, ServiceError, type Ctx } from './common';

/**
 * Workshop: clubs left with the shop for regripping, reshafting, adjustments and repairs.
 * Any staff member can check clubs in and update them; the customer is emailed on check-in,
 * on delays/new dates, and when the job is ready to collect.
 */

export { WORK_TYPES, WORKSHOP_STATUS_LABELS } from '../workshop-constants';

const OPEN: WorkshopStatus[] = ['checked_in', 'in_progress', 'waiting_parts'];

const isoDate = z
  .string()
  .trim()
  .default('')
  .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Use a date')
  .transform((v) => v || null);

const price = z.string().default('0').transform((v, c) => {
  const p = parseMoneyToPence(v || '0');
  if (p === null || p < 0) {
    c.addIssue({ code: 'custom', message: 'Enter a price like 12.50' });
    return z.NEVER;
  }
  return p;
});

const itemSchema = z.object({
  club: z.string().trim().min(1, 'Which club?').max(80),
  work: z.string().trim().min(1, 'What work?').max(80),
  parts: z.string().trim().max(160).default(''),
  quantity: z.coerce.number().int().min(1).max(30).default(1),
  pricePence: price,
});

const createSchema = z.object({
  ...customerFields,
  items: z.array(itemSchema).min(1, 'Add at least one club').max(30),
  etaDate: isoDate,
  notes: z.string().trim().max(2000).default(''),
});

const progressSchema = z.object({
  status: z.enum(['checked_in', 'in_progress', 'waiting_parts', 'ready', 'collected', 'cancelled']),
  etaDate: isoDate,
  delayReason: z.string().trim().max(300).default(''),
});

/** The job's clubs as the line-by-line block used in emails and on screen. */
export function jobSpec(job: Pick<WorkshopJob, 'reference'>, items: Pick<WorkshopItem, 'club' | 'work' | 'parts' | 'quantity' | 'pricePence'>[]): FitSpec {
  const total = items.reduce((s, i) => s + i.pricePence, 0);
  return {
    kind: 'cos-configure',
    version: 2,
    totalPence: total,
    builds: [
      {
        title: `Workshop job ${job.reference}`,
        lines: items.map((i) => ({
          label: i.quantity > 1 ? `${i.club} ×${i.quantity}` : i.club,
          value: [i.work, i.parts].filter(Boolean).join(' — '),
          pricePence: i.pricePence,
        })),
        totalPence: total,
      },
    ],
  };
}

/** A private, revocable customer link to the job's progress page (only its hash is stored). */
export async function issueWorkshopLink(tx: DB, orgId: string, jobId: string): Promise<string> {
  const token = newToken();
  await tx.insert(trackingTokens).values({ organisationId: orgId, workshopJobId: jobId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 365 * 86_400_000) });
  return appUrl(`/w/${token}`);
}

function emailContext(job: WorkshopJob, c: Customer, items: WorkshopItem[], extra: { previousEtaDate?: string | null; link?: string } = {}) {
  const spec = jobSpec(job, items);
  return {
    customerName: c.name,
    reference: job.reference,
    brand: 'Workshop',
    product: `${items.length} club${items.length === 1 ? '' : 's'}`,
    specification: items.map((i) => `${i.club}: ${[i.work, i.parts].filter(Boolean).join(' — ')}`).join('\n'),
    totalPence: spec.totalPence,
    etaDate: job.etaDate,
    previousEtaDate: extra.previousEtaDate ?? null,
    etaReason: job.delayReason,
    fit: spec,
    actionUrl: extra.link,
  };
}

async function liveItems(tx: DB, jobId: string) {
  return tx.select().from(workshopItems).where(and(eq(workshopItems.jobId, jobId), isNull(workshopItems.removedAt))).orderBy(asc(workshopItems.createdAt));
}

async function load(tx: DB, ctx: Ctx, id: string) {
  const [row] = await tx
    .select({ job: workshopJobs, customer: customers })
    .from(workshopJobs)
    .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
    .where(and(eq(workshopJobs.id, id), eq(workshopJobs.organisationId, ctx.org.id)))
    .for('update', { of: workshopJobs })
    .limit(1);
  if (!row) throw new ServiceError('Workshop job not found.');
  return row;
}

export async function checkInClubs(ctx: Ctx, raw: unknown, opts: { notify?: boolean } = {}) {
  if (!ctx.userId) throw new ServiceError('Sign in to check clubs in.');
  const input = parse(createSchema, raw);
  // Only managers may skip telling the customer, as with orders.
  const notify = opts.notify !== false || !atLeast(ctx, 'manager');
  const { job, messageId } = await withTenant(ctx.org.id, async (tx) => {
    const customer = await findOrCreateCustomer(tx, ctx, { name: input.customerName, email: input.email, phone: input.phone, customerId: input.customerId });
    const [{ n }] = await tx
      .update(organisations)
      .set({ nextWorkshopNumber: sql`${organisations.nextWorkshopNumber} + 1` })
      .where(eq(organisations.id, ctx.org.id))
      .returning({ n: organisations.nextWorkshopNumber });
    const [job] = await tx
      .insert(workshopJobs)
      .values({
        organisationId: ctx.org.id, reference: `WS-${n - 1}`, customerId: customer.id, etaDate: input.etaDate, notes: input.notes,
        takenByUserId: ctx.userId!,
      })
      .returning();
    const items = await tx.insert(workshopItems).values(input.items.map((i) => ({ organisationId: ctx.org.id, jobId: job.id, ...i }))).returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'workshop_job_created', entityType: 'workshop_job', entityId: job.id,
      customerId: customer.id,
      newValue: { reference: job.reference, etaDate: job.etaDate, items: items.map((i) => `${i.club}: ${i.work}`), totalPence: items.reduce((s, i) => s + i.pricePence, 0) },
    });
    const messageId = await enqueueEmail(tx, {
      org: ctx.org, template: 'workshop_checked_in', recipient: customer.email, customerId: customer.id, workshopJobId: job.id,
      context: emailContext(job, customer, items, { link: await issueWorkshopLink(tx, ctx.org.id, job.id) }), actor: ctx.actor,
      suppressedBy: notify ? null : ctx.actor.type === 'user' ? ctx.actor.name : 'COS',
    });
    return { job, messageId };
  });
  await dispatchMessages(ctx.org, [messageId]);
  return job;
}

/**
 * Moves a job along. Waiting for parts needs a reason the customer will see. The customer is
 * emailed when it's delayed or its ready date changes, and when it's ready to collect.
 */
export async function updateWorkshopProgress(ctx: Ctx, id: string, raw: unknown, opts: { notify?: boolean } = {}) {
  const input = parse(progressSchema, raw);
  const notify = opts.notify !== false || !atLeast(ctx, 'manager');
  if (input.status === 'cancelled') requireRole(ctx, 'manager', 'cancel workshop jobs');
  if (input.status === 'waiting_parts' && !input.delayReason) {
    throw new ServiceError('Say what you’re waiting for — the customer will see it.', { delayReason: 'e.g. Waiting for grips to arrive' });
  }
  const messageId = await withTenant(ctx.org.id, async (tx) => {
    const { job, customer } = await load(tx, ctx, id);
    if (job.status === 'cancelled' || (job.status === 'collected' && !atLeast(ctx, 'manager'))) {
      throw new ServiceError(`This job is ${WORKSHOP_STATUS_LABELS[job.status].toLowerCase()}.`);
    }
    const now = new Date();
    const statusChanged = input.status !== job.status;
    const etaChanged = input.etaDate !== job.etaDate;
    const reasonChanged = input.delayReason !== job.delayReason && !['ready', 'collected', 'cancelled'].includes(input.status);
    if (!statusChanged && !etaChanged && !reasonChanged) return null;
    // Once the work is finished the delay note no longer applies.
    const finished = ['ready', 'collected', 'cancelled'].includes(input.status);
    const patch: Partial<WorkshopJob> = { etaDate: input.etaDate, delayReason: finished ? '' : input.delayReason, updatedAt: now };
    if (statusChanged) {
      patch.status = input.status;
      patch.statusChangedAt = now;
      if (input.status === 'ready') patch.readyAt = now;
      if (input.status === 'collected') patch.collectedAt = now;
    }
    await tx.update(workshopJobs).set(patch).where(eq(workshopJobs.id, id));
    if (statusChanged) {
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'workshop_status_changed', entityType: 'workshop_job', entityId: id,
        customerId: customer.id, oldValue: { status: job.status },
        newValue: { status: input.status, delayReason: input.status === 'waiting_parts' ? input.delayReason : undefined },
      });
    }
    if (etaChanged) {
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'workshop_eta_changed', entityType: 'workshop_job', entityId: id,
        customerId: customer.id, oldValue: { etaDate: job.etaDate }, newValue: { etaDate: input.etaDate, reason: input.delayReason || undefined },
      });
    }
    const updated = { ...job, ...patch } as WorkshopJob;
    const items = await liveItems(tx, id);
    const suppressedBy = notify ? null : ctx.actor.type === 'user' ? ctx.actor.name : 'COS';
    if (statusChanged && input.status === 'ready') {
      return enqueueEmail(tx, {
        org: ctx.org, template: 'workshop_ready', recipient: customer.email, customerId: customer.id, workshopJobId: id,
        context: emailContext(updated, customer, items, { link: await issueWorkshopLink(tx, ctx.org.id, id) }), actor: ctx.actor, suppressedBy,
      });
    }
    const delayed = (statusChanged && input.status === 'waiting_parts') || (etaChanged && OPEN.includes(updated.status) && job.etaDate !== null);
    if (delayed) {
      return enqueueEmail(tx, {
        org: ctx.org, template: 'workshop_delayed', recipient: customer.email, customerId: customer.id, workshopJobId: id,
        context: emailContext(updated, customer, items, { previousEtaDate: etaChanged ? job.etaDate : null, link: await issueWorkshopLink(tx, ctx.org.id, id) }),
        actor: ctx.actor, suppressedBy,
      });
    }
    return null;
  });
  await dispatchMessages(ctx.org, [messageId]);
}

export async function addWorkshopItem(ctx: Ctx, id: string, raw: unknown) {
  const v = parse(itemSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const { job } = await load(tx, ctx, id);
    if (!OPEN.includes(job.status)) throw new ServiceError('Clubs can only be added while the job is open.');
    await tx.insert(workshopItems).values({ organisationId: ctx.org.id, jobId: id, ...v });
    await tx.update(workshopJobs).set({ updatedAt: new Date() }).where(eq(workshopJobs.id, id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'workshop_item_added', entityType: 'workshop_job', entityId: id,
      customerId: job.customerId, newValue: { club: v.club, work: v.work, parts: v.parts, pricePence: v.pricePence },
    });
  });
}

export async function removeWorkshopItem(ctx: Ctx, id: string, itemId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const { job } = await load(tx, ctx, id);
    if (!OPEN.includes(job.status)) throw new ServiceError('Clubs can only be removed while the job is open.');
    const items = await liveItems(tx, id);
    const item = items.find((i) => i.id === itemId);
    if (!item) throw new ServiceError('Item not found.');
    if (items.length === 1) throw new ServiceError('A job needs at least one club. Cancel the job instead.');
    await tx.update(workshopItems).set({ removedAt: new Date() }).where(eq(workshopItems.id, itemId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'workshop_item_removed', entityType: 'workshop_job', entityId: id,
      customerId: job.customerId, oldValue: { club: item.club, work: item.work },
    });
  });
}

export type JobRow = WorkshopJob & { customerName: string; customerEmail: string; items: number; summary: string; totalPence: number };

export async function listJobs(orgId: string, opts: { customerId?: string } = {}): Promise<JobRow[]> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({
        job: workshopJobs,
        customerName: customers.name,
        customerEmail: customers.email,
        items: sql<number>`count(${workshopItems.id})::int`,
        summary: sql<string>`coalesce(string_agg(${workshopItems.club} || ': ' || ${workshopItems.work}, ', ' order by ${workshopItems.createdAt}), '')`,
        totalPence: sql<number>`coalesce(sum(${workshopItems.pricePence}), 0)::int`,
      })
      .from(workshopJobs)
      .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
      .leftJoin(workshopItems, and(eq(workshopItems.jobId, workshopJobs.id), isNull(workshopItems.removedAt)))
      .where(and(isNull(workshopJobs.archivedAt), opts.customerId ? eq(workshopJobs.customerId, opts.customerId) : undefined))
      .groupBy(workshopJobs.id, customers.name, customers.email)
      .orderBy(asc(sql`coalesce(${workshopJobs.etaDate}, '9999-12-31')`), desc(workshopJobs.createdAt));
    return rows.map(({ job, ...r }) => ({ ...job, ...r }));
  });
}

export async function getJob(orgId: string, reference: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ job: workshopJobs, customer: customers, takenBy: users.name })
      .from(workshopJobs)
      .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
      .innerJoin(users, eq(users.id, workshopJobs.takenByUserId))
      .where(eq(workshopJobs.reference, reference))
      .limit(1);
    if (!row) return null;
    const [items, events, emails] = await Promise.all([
      liveItems(tx, row.job.id),
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, row.job.id)).orderBy(desc(auditEvents.createdAt)),
      tx.select().from(messages).where(eq(messages.workshopJobId, row.job.id)).orderBy(desc(messages.createdAt)),
    ]);
    return { ...row, items, events, emails };
  });
}

export function formatJobTotal(items: Pick<WorkshopItem, 'pricePence'>[]) {
  return money(items.reduce((s, i) => s + i.pricePence, 0));
}

/**
 * Daily: a friendly reminder for jobs ready but not collected after the shop's "ready but
 * uncollected" days — at most once per that many days per job.
 */
export async function sendWorkshopReminders(org: Organisation, now = new Date()) {
  const cutoff = new Date(now.getTime() - org.readyUncollectedDays * 86_400_000);
  const ids = await withTenant(org.id, async (tx) => {
    const due = await tx
      .select({ job: workshopJobs, customer: customers })
      .from(workshopJobs)
      .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
      .where(
        and(
          eq(workshopJobs.status, 'ready'),
          isNull(workshopJobs.archivedAt),
          lt(workshopJobs.readyAt, cutoff),
          or(isNull(workshopJobs.lastReminderAt), lt(workshopJobs.lastReminderAt, cutoff)),
        ),
      );
    const out: (string | null)[] = [];
    for (const { job, customer } of due) {
      const items = await liveItems(tx, job.id);
      out.push(
        await enqueueEmail(tx, {
          org, template: 'workshop_reminder', recipient: customer.email, customerId: customer.id, workshopJobId: job.id,
          context: emailContext(job, customer, items, { link: await issueWorkshopLink(tx, org.id, job.id) }), actor: SYSTEM,
        }),
      );
      await tx.update(workshopJobs).set({ lastReminderAt: now }).where(eq(workshopJobs.id, job.id));
    }
    return out;
  });
  await dispatchMessages(org, ids);
  return ids.length;
}
