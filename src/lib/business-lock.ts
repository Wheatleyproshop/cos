import 'server-only';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { systemDb, withTenant } from '@/db';
import { users } from '@/db/schema';
import { recordEvent, staffActor } from './audit';
import { requireStaff, verifyPassword, type Staff } from './auth';
import { safeEqual, signValue } from './tokens';

/**
 * The owner's Business area (bank, payroll, staff records) sits behind a second lock: owner/admin
 * role, plus their password re-entered. Unlocking sets a signed, short-lived cookie tied to the
 * person, renewed while they keep using it; it locks again after 15 minutes idle or on sign-out.
 */
const COOKIE = 'cos_business';
export const BUSINESS_IDLE_MINUTES = 15;
const MAX_TRIES = 5;

function token(userId: string, until: number) {
  const v = `${userId}.${until}`;
  return `${v}.${signValue(`business:${v}`)}`;
}

function valid(raw: string | undefined, userId: string) {
  if (!raw) return false;
  const [uid, until, sig] = raw.split('.');
  if (!uid || !until || !sig || uid !== userId || Number(until) < Date.now()) return false;
  return safeEqual(sig, signValue(`business:${uid}.${until}`));
}

async function setCookie(userId: string) {
  const until = Date.now() + BUSINESS_IDLE_MINUTES * 60_000;
  (await cookies()).set(COOKIE, token(userId, until), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: BUSINESS_IDLE_MINUTES * 60,
  });
}

/** True when this owner has unlocked the Business area recently. */
export async function businessUnlocked(staff: Staff) {
  return staff.role === 'admin' && !staff.sharedLoginName && valid((await cookies()).get(COOKIE)?.value, staff.id);
}

/**
 * Use at the top of every Business page and action. Not an owner → back to the dashboard;
 * locked → the unlock screen. Each use extends the 15 minutes (cookies can only be set in actions/route handlers).
 */
export async function requireBusiness(opts: { renew?: boolean } = {}): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.sharedLoginName) redirect('/');
  if (!(await businessUnlocked(staff))) redirect('/business/unlock');
  if (opts.renew) await setCookie(staff.id);
  return staff;
}

/** Checks the owner's password and unlocks. Wrong passwords count towards the normal sign-in lockout. */
export async function unlockBusiness(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.sharedLoginName) return { ok: false, error: 'Only the owner can open the Business area.' };
  const db = systemDb();
  const [u] = await db.select().from(users).where(eq(users.id, staff.id)).limit(1);
  if (!u) return { ok: false, error: 'Account not found.' };
  if (u.lockedUntil && u.lockedUntil > new Date()) return { ok: false, error: 'Too many wrong attempts. Try again in 15 minutes.' };
  const actor = staffActor({ id: staff.id, name: staff.name });
  if (!(await verifyPassword(password, u.passwordHash))) {
    const failed = u.failedLoginCount + 1;
    await db
      .update(users)
      .set({ failedLoginCount: failed >= MAX_TRIES ? 0 : failed, lockedUntil: failed >= MAX_TRIES ? new Date(Date.now() + 15 * 60_000) : null })
      .where(eq(users.id, u.id));
    await withTenant(staff.organisationId, (tx) =>
      recordEvent(tx, { organisationId: staff.organisationId, actor, eventType: 'business_unlock_failed', entityType: 'organisation', entityId: staff.organisationId }),
    );
    return { ok: false, error: 'That password isn’t right.' };
  }
  if (u.failedLoginCount) await db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, u.id));
  await setCookie(staff.id);
  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, { organisationId: staff.organisationId, actor, eventType: 'business_unlocked', entityType: 'organisation', entityId: staff.organisationId }),
  );
  return { ok: true };
}

export async function lockBusiness() {
  (await cookies()).delete(COOKIE);
}
