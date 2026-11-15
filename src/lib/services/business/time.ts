import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { withTenant } from '@/db';
import { rotaShifts, timeEntries, users } from '@/db/schema';
import { recordEvent } from '../../audit';
import { ServiceError, type Ctx } from '../common';

/**
 * Timesheets (hours actually worked) and the rota (shifts planned). Times are entered and shown in the
 * shop's time zone; stored as instants. Owner edits are recorded with before/after on the history.
 */

/** Midnight at the start of a calendar date in the shop's time zone, as an instant. */
export function zonedDayStart(dateIso: string, tz: string): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  // The time zone's offset at that date (UK clocks change at 1–2am, never at midnight).
  const guess = new Date(Date.UTC(y, m - 1, d));
  const wall = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (wall.getTime() - utc.getTime()));
}

/** A wall-clock date + "HH:MM" in the shop's time zone, as an instant. */
export function zonedTime(dateIso: string, hhmm: string, tz: string): Date {
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(zonedDayStart(dateIso, tz).getTime() + (h * 60 + mi) * 60_000);
}

export const workedMinutes = (e: { clockIn: Date; clockOut: Date | null; breakMinutes: number }, now = new Date()) =>
  Math.max(0, Math.round(((e.clockOut ?? now).getTime() - e.clockIn.getTime()) / 60_000) - e.breakMinutes);

/** Monday of the week containing `dateIso`. */
export function weekStart(dateIso: string) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Entries between two dates (inclusive start, exclusive end), with names. */
export async function timeEntriesBetween(orgId: string, from: string, to: string, tz: string, userId?: string) {
  const a = zonedDayStart(from, tz);
  const b = zonedDayStart(to, tz);
  return withTenant(orgId, (tx) =>
    tx
      .select({ e: timeEntries, name: users.name })
      .from(timeEntries)
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .where(and(gte(timeEntries.clockIn, a), lt(timeEntries.clockIn, b), isNull(timeEntries.removedAt), userId ? eq(timeEntries.userId, userId) : undefined))
      .orderBy(asc(timeEntries.clockIn)),
  );
}

type EntryInput = { userId: string; date: string; start: string; end: string; breakMinutes: string; note: string };

function checkEntry(v: EntryInput, tz: string) {
  const errs: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) errs.date = 'Pick a date';
  if (!/^\d{2}:\d{2}$/.test(v.start)) errs.start = 'Start time';
  if (v.end && !/^\d{2}:\d{2}$/.test(v.end)) errs.end = 'End time';
  const brk = Number(v.breakMinutes || 0);
  if (!Number.isInteger(brk) || brk < 0 || brk > 240) errs.breakMinutes = '0–240 minutes';
  if (Object.keys(errs).length) throw new ServiceError('Please check the highlighted fields.', errs);
  const clockIn = zonedTime(v.date, v.start, tz);
  let clockOut = v.end ? zonedTime(v.date, v.end, tz) : null;
  if (clockOut && clockOut <= clockIn) clockOut = new Date(clockOut.getTime() + 86_400_000); // past midnight
  if (clockOut && clockOut.getTime() - clockIn.getTime() > 16 * 3_600_000) throw new ServiceError('A shift can’t be longer than 16 hours.', { end: 'Too long' });
  if (clockIn > new Date(Date.now() + 3_600_000)) throw new ServiceError('That shift is in the future — use the rota for planned shifts.', { date: 'In the future' });
  return { clockIn, clockOut, breakMinutes: brk, note: v.note.trim().slice(0, 300) };
}

const snap = (e: { clockIn: Date; clockOut: Date | null; breakMinutes: number; note: string }) => ({
  clockIn: e.clockIn.toISOString(), clockOut: e.clockOut?.toISOString() ?? null, breakMinutes: e.breakMinutes, note: e.note,
});

export async function addTimeEntry(ctx: Ctx, v: EntryInput) {
  const e = checkEntry(v, ctx.org.timezone);
  await withTenant(ctx.org.id, async (tx) => {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, v.userId)).limit(1);
    if (!u) throw new ServiceError('Pick a team member.', { userId: 'Pick someone' });
    const [row] = await tx.insert(timeEntries).values({ organisationId: ctx.org.id, userId: v.userId, ...e, source: 'manual' }).returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'time_entry_added', entityType: 'user', entityId: v.userId,
      newValue: snap(row), metadata: { name: u.name, entryId: row.id },
    });
  });
}

export async function updateTimeEntry(ctx: Ctx, entryId: string, v: Omit<EntryInput, 'userId'>) {
  const e = checkEntry({ ...v, userId: '' }, ctx.org.timezone);
  await withTenant(ctx.org.id, async (tx) => {
    const [before] = await tx.select().from(timeEntries).where(eq(timeEntries.id, entryId)).limit(1);
    if (!before || before.removedAt) throw new ServiceError('That shift has been removed.');
    await tx.update(timeEntries).set({ ...e, updatedAt: new Date() }).where(eq(timeEntries.id, entryId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'time_entry_changed', entityType: 'user', entityId: before.userId,
      oldValue: snap(before), newValue: snap(e), metadata: { entryId },
    });
  });
}

export async function removeTimeEntry(ctx: Ctx, entryId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [before] = await tx.select().from(timeEntries).where(eq(timeEntries.id, entryId)).limit(1);
    if (!before || before.removedAt) return;
    await tx.update(timeEntries).set({ removedAt: new Date(), updatedAt: new Date() }).where(eq(timeEntries.id, entryId));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'time_entry_removed', entityType: 'user', entityId: before.userId, oldValue: snap(before), metadata: { entryId } });
  });
}

/* ─────────────────────────────── Rota ─────────────────────────────── */

export async function rotaBetween(orgId: string, from: string, to: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ s: rotaShifts, name: users.name })
      .from(rotaShifts)
      .innerJoin(users, eq(users.id, rotaShifts.userId))
      .where(and(gte(rotaShifts.date, from), lt(rotaShifts.date, to), isNull(rotaShifts.removedAt)))
      .orderBy(asc(rotaShifts.date), asc(rotaShifts.startTime)),
  );
}

export async function addRotaShift(ctx: Ctx, v: { userId: string; date: string; start: string; end: string; note: string }) {
  const errs: Record<string, string> = {};
  if (!v.userId) errs.userId = 'Pick someone';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) errs.date = 'Pick a date';
  if (!/^\d{2}:\d{2}$/.test(v.start)) errs.start = 'Start time';
  if (!/^\d{2}:\d{2}$/.test(v.end)) errs.end = 'End time';
  if (Object.keys(errs).length) throw new ServiceError('Please check the highlighted fields.', errs);
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .insert(rotaShifts)
      .values({ organisationId: ctx.org.id, userId: v.userId, date: v.date, startTime: v.start, endTime: v.end, note: v.note.trim().slice(0, 200) })
      .returning();
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'rota_changed', entityType: 'user', entityId: v.userId, newValue: { date: v.date, start: v.start, end: v.end }, metadata: { shiftId: row.id } });
  });
}

export async function removeRotaShift(ctx: Ctx, shiftId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [s] = await tx.select().from(rotaShifts).where(eq(rotaShifts.id, shiftId)).limit(1);
    if (!s || s.removedAt) return;
    await tx.update(rotaShifts).set({ removedAt: new Date() }).where(eq(rotaShifts.id, shiftId));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'rota_changed', entityType: 'user', entityId: s.userId, oldValue: { date: s.date, start: s.startTime, end: s.endTime }, metadata: { shiftId, removed: true } });
  });
}

/** Copies last week's rota into this week (skipping anything already planned for the same person and day). */
export async function copyRotaWeek(ctx: Ctx, week: string) {
  const prev = addDaysIso(week, -7);
  const [last, current] = await Promise.all([rotaBetween(ctx.org.id, prev, week), rotaBetween(ctx.org.id, week, addDaysIso(week, 7))]);
  let n = 0;
  for (const { s } of last) {
    const date = addDaysIso(s.date, 7);
    if (current.some((c) => c.s.userId === s.userId && c.s.date === date)) continue;
    await addRotaShift(ctx, { userId: s.userId, date, start: s.startTime, end: s.endTime, note: s.note });
    n++;
  }
  return n;
}
