import bcrypt from 'bcryptjs';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import { auditEvents, staffProfiles, timeEntries, users, type StaffSensitive } from '@/db/schema';
import { recordEvent, type Actor } from '../../audit';
import { parseMoneyToPence } from '../../format';
import { decryptSecret, encryptSecret } from '../../tokens';
import { ServiceError, type Ctx } from '../common';

/** Team members with an HR record (shared counter logins aren't people, so they're left out). */
export async function listStaff(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ u: users, p: staffProfiles })
      .from(users)
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.sharedLogin, false), isNull(users.removedAt)))
      .orderBy(asc(users.name));
    return rows.map(({ u, p }) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
      profile: p ? { ...p, sensitiveEncrypted: undefined, clockPinHash: undefined, hasPin: Boolean(p.clockPinHash), hasSensitive: Boolean(p.sensitiveEncrypted) } : null,
    }));
  });
}
export type StaffRow = Awaited<ReturnType<typeof listStaff>>[number];

export async function getStaffRecord(ctx: Ctx, userId: string, opts: { reveal?: boolean } = {}) {
  return withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.select({ u: users, p: staffProfiles }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.id, userId)).limit(1);
    if (!row || row.u.sharedLogin) throw new ServiceError('Team member not found.');
    let sensitive: StaffSensitive | null = null;
    if (opts.reveal && row.p?.sensitiveEncrypted) {
      sensitive = JSON.parse(decryptSecret(row.p.sensitiveEncrypted)) as StaffSensitive;
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'staff_sensitive_viewed', entityType: 'user', entityId: userId,
        metadata: { name: row.u.name },
      });
    }
    return {
      user: { id: row.u.id, name: row.u.name, email: row.u.email, role: row.u.role, active: row.u.active },
      profile: row.p ? { ...row.p, sensitiveEncrypted: undefined, clockPinHash: undefined, hasPin: Boolean(row.p.clockPinHash), hasSensitive: Boolean(row.p.sensitiveEncrypted) } : null,
      sensitive,
    };
  });
}

const t = (n: number) => z.string().trim().max(n).default('');
const date = z
  .string()
  .trim()
  .default('')
  .refine((s) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s), 'Use a valid date')
  .transform((s) => s || null);
const money = (label: string) =>
  z.string().trim().default('').transform((v, c) => {
    if (!v) return 0;
    const p = parseMoneyToPence(v);
    if (p === null || p < 0) {
      c.addIssue({ code: 'custom', message: `${label} must be an amount, e.g. 12.21` });
      return z.NEVER;
    }
    return p;
  });
const hoursToMinutes = z.string().trim().default('').transform((v, c) => {
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 80) {
    c.addIssue({ code: 'custom', message: 'Hours per week between 0 and 80' });
    return z.NEVER;
  }
  return Math.round(n * 60);
});

const profileSchema = z.object({
  jobTitle: t(80), phone: t(40), personalEmail: t(160), startDate: date, endDate: date,
  payType: z.enum(['hourly', 'salary']).default('hourly'),
  hourlyRatePence: money('Hourly rate'), annualSalaryPence: money('Annual salary'),
  contractedMinutesPerWeek: hoursToMinutes,
  holidayTenthsPerYear: z.string().trim().default('28').transform((v, c) => {
    const n = Number(v || '0');
    if (!Number.isFinite(n) || n < 0 || n > 60) {
      c.addIssue({ code: 'custom', message: 'Holiday days between 0 and 60' });
      return z.NEVER;
    }
    return Math.round(n * 10);
  }),
  emergencyName: t(120), emergencyPhone: t(40), emergencyRelation: t(60), notes: t(4000),
});

const NI = /^[A-Z]{2}\d{6}[A-D]$/;
const sensitiveSchema = z.object({
  niNumber: t(20).transform((v, c) => {
    const s = v.replace(/\s+/g, '').toUpperCase();
    if (s && !NI.test(s)) {
      c.addIssue({ code: 'custom', message: 'Looks like QQ 12 34 56 C' });
      return z.NEVER;
    }
    return s;
  }),
  dateOfBirth: t(10).refine((s) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s), 'Use a valid date'),
  address: t(400), postcode: t(12).transform((v) => v.toUpperCase()), taxCode: t(12).transform((v) => v.replace(/\s+/g, '').toUpperCase()),
  bankName: t(60), accountName: t(80),
  sortCode: t(10).transform((v, c) => {
    const d = v.replace(/\D/g, '');
    if (v && d.length !== 6) {
      c.addIssue({ code: 'custom', message: 'Six digits, e.g. 12-34-56' });
      return z.NEVER;
    }
    return d ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : '';
  }),
  accountNumber: t(10).transform((v, c) => {
    const d = v.replace(/\D/g, '');
    if (v && d.length !== 8) {
      c.addIssue({ code: 'custom', message: 'Eight digits' });
      return z.NEVER;
    }
    return d;
  }),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string> = {};
  for (const i of r.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
  throw new ServiceError('Please check the highlighted fields.', fieldErrors);
}

/**
 * Saves the HR record. Sensitive fields are only replaced when `includeSensitive` (the owner had them
 * revealed on the form); otherwise the stored encrypted copy is kept as it is.
 */
export async function saveStaffRecord(ctx: Ctx, userId: string, raw: Record<string, unknown>, opts: { includeSensitive: boolean }) {
  const v = parse(profileSchema, raw);
  const sens = opts.includeSensitive ? parse(sensitiveSchema, raw) : null;
  await withTenant(ctx.org.id, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.sharedLogin) throw new ServiceError('Team member not found.');
    const [before] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
    const sensitiveEncrypted = sens
      ? Object.values(sens).some(Boolean)
        ? encryptSecret(JSON.stringify(sens))
        : null
      : (before?.sensitiveEncrypted ?? null);
    const values = { ...v, sensitiveEncrypted, updatedAt: new Date() };
    if (before) await tx.update(staffProfiles).set(values).where(eq(staffProfiles.id, before.id));
    else await tx.insert(staffProfiles).values({ organisationId: ctx.org.id, userId, ...values });
    // What changed, without ever writing the sensitive values or pay figures into the history in full.
    const changed = before ? (Object.keys(v) as (keyof typeof v)[]).filter((k) => String(before[k] ?? '') !== String(v[k] ?? '')) : Object.keys(v);
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'staff_profile_saved', entityType: 'user', entityId: userId,
      metadata: { name: u.name, changed, sensitiveChanged: Boolean(sens) && sensitiveEncrypted !== before?.sensitiveEncrypted },
    });
  });
}

/** Sets (or clears) someone's clock-in PIN: 4 to 6 digits. */
export async function setClockPin(ctx: Ctx, userId: string, pin: string) {
  const p = pin.trim();
  if (p && !/^\d{4,6}$/.test(p)) throw new ServiceError('A PIN is 4 to 6 digits.', { pin: '4 to 6 digits' });
  if (/^(\d)\1+$/.test(p) || ['1234', '12345', '123456', '4321'].includes(p)) throw new ServiceError('Pick a PIN that’s harder to guess.', { pin: 'Too easy to guess' });
  const hash = p ? await bcrypt.hash(p, 10) : null;
  await withTenant(ctx.org.id, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.sharedLogin) throw new ServiceError('Team member not found.');
    const [before] = await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
    if (before) await tx.update(staffProfiles).set({ clockPinHash: hash, updatedAt: new Date() }).where(eq(staffProfiles.id, before.id));
    else await tx.insert(staffProfiles).values({ organisationId: ctx.org.id, userId, clockPinHash: hash });
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'clock_pin_set', entityType: 'user', entityId: userId, metadata: { name: u.name, cleared: !p } });
  });
}

/* ───────────────────────────── Time clock ───────────────────────────── */

/** Who can clock in on the shop screen, and who's in right now. */
export async function clockBoard(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const people = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.active, true), eq(users.sharedLogin, false), isNull(users.removedAt), sql`${staffProfiles.clockPinHash} is not null`, isNull(staffProfiles.endDate)))
      .orderBy(asc(users.name));
    const open = await tx
      .select({ userId: timeEntries.userId, clockIn: timeEntries.clockIn })
      .from(timeEntries)
      .where(and(isNull(timeEntries.clockOut), isNull(timeEntries.removedAt)));
    return people.map((p) => ({ ...p, inSince: open.find((o) => o.userId === p.id)?.clockIn ?? null }));
  });
}

const CLOCK_TRIES = 5;

/** Clocks someone in, or out if they're already in. Wrong PINs are counted; 5 in 15 minutes locks that person out for a while. */
export async function clockToggle(orgId: string, userId: string, pin: string, device: Actor) {
  const res = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ name: users.name, pinHash: staffProfiles.clockPinHash, active: users.active })
      .from(users)
      .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.pinHash || !row.active) throw new ServiceError('This person can’t clock in yet — ask the owner to set their PIN.');
    const [fails] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, 'clock_pin_failed'), eq(auditEvents.entityId, userId), gt(auditEvents.createdAt, sql`now() - interval '15 minutes'`)));
    if (fails.n >= CLOCK_TRIES) throw new ServiceError('Too many wrong PINs. Try again in 15 minutes, or ask the owner.');
    if (!(await bcrypt.compare(pin.trim(), row.pinHash))) {
      // Recorded (and committed) before saying no, so repeated guesses count towards the lockout.
      await recordEvent(tx, { organisationId: orgId, actor: device, eventType: 'clock_pin_failed', entityType: 'user', entityId: userId, metadata: { name: row.name } });
      return null;
    }
    const person: Actor = { type: 'user', userId, name: row.name };
    const now = new Date();
    const [open] = await tx
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.clockOut), isNull(timeEntries.removedAt)))
      .limit(1);
    if (open) {
      await tx.update(timeEntries).set({ clockOut: now, updatedAt: now }).where(eq(timeEntries.id, open.id));
      await recordEvent(tx, { organisationId: orgId, actor: person, eventType: 'clocked_out', entityType: 'user', entityId: userId, metadata: { entryId: open.id } });
      return { name: row.name, action: 'out' as const, minutes: Math.round((now.getTime() - open.clockIn.getTime()) / 60_000) };
    }
    const [e] = await tx.insert(timeEntries).values({ organisationId: orgId, userId, clockIn: now, source: 'clock' }).returning();
    await recordEvent(tx, { organisationId: orgId, actor: person, eventType: 'clocked_in', entityType: 'user', entityId: userId, metadata: { entryId: e.id } });
    return { name: row.name, action: 'in' as const, minutes: 0 };
  });
  if (!res) throw new ServiceError('That PIN isn’t right.', { pin: 'Wrong PIN' });
  return res;
}
