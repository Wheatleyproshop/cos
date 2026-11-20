import 'server-only';
import bcrypt from 'bcryptjs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { systemDb, withTenant } from '@/db';
import { auditEvents, organisations, users } from '@/db/schema';
import { recordEvent, staffActor } from './audit';
import { requireStaff, verifyPassword, type Staff } from './auth';
import { safeEqual, signValue } from './tokens';

/**
 * The Business area (bank, payroll, staff records, tax) is for one person: the owner who set its
 * passcode. Nobody else sees it — not other admins, not the shared shop login. The passcode is separate
 * from the sign-in password and is asked for every time the area is opened: it locks when you leave it,
 * close the tab, sign out, press Lock, or after 15 minutes without use.
 */
export const BUSINESS_COOKIE = 'cos_business';
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
  // No maxAge: a session cookie, so closing the browser also locks it.
  (await cookies()).set(BUSINESS_COOKIE, token(userId, until), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
}

/** Whether this person may see the Business area at all (before any passcode). */
export function canSeeBusiness(staff: Pick<Staff, 'id' | 'role' | 'sharedLoginName' | 'org'>) {
  if (staff.role !== 'admin' || staff.sharedLoginName) return false;
  return !staff.org.businessOwnerId || staff.org.businessOwnerId === staff.id;
}

export async function businessUnlocked(staff: Staff) {
  return canSeeBusiness(staff) && Boolean(staff.org.businessPasscodeHash) && valid((await cookies()).get(BUSINESS_COOKIE)?.value, staff.id);
}

/** Top of every Business page, action and download. Not theirs → dashboard; locked → passcode screen. */
export async function requireBusiness(opts: { renew?: boolean } = {}): Promise<Staff> {
  const staff = await requireStaff();
  if (!canSeeBusiness(staff)) redirect('/');
  if (!(await businessUnlocked(staff))) redirect('/business/unlock');
  if (opts.renew) await setCookie(staff.id);
  return staff;
}

type Result = { ok: true } | { ok: false; error: string; field?: string };

async function recentFailures(orgId: string, userId: string) {
  const [r] = await withTenant(orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, 'business_unlock_failed'), eq(auditEvents.entityId, userId), gt(auditEvents.createdAt, sql`now() - interval '15 minutes'`))),
  );
  return r?.n ?? 0;
}

/** Opens the Business area with its passcode. Wrong passcodes are recorded (and committed) before saying no. */
export async function unlockBusiness(passcode: string): Promise<Result> {
  const staff = await requireStaff();
  if (!canSeeBusiness(staff)) return { ok: false, error: 'The Business area is private to its owner.' };
  if (!staff.org.businessPasscodeHash) return { ok: false, error: 'Set a passcode first.' };
  if ((await recentFailures(staff.organisationId, staff.id)) >= MAX_TRIES) return { ok: false, error: 'Too many wrong passcodes. Try again in 15 minutes, or reset it with your account password.' };
  const actor = staffActor({ id: staff.id, name: staff.name });
  if (!(await bcrypt.compare(passcode.trim(), staff.org.businessPasscodeHash))) {
    await withTenant(staff.organisationId, (tx) =>
      recordEvent(tx, { organisationId: staff.organisationId, actor, eventType: 'business_unlock_failed', entityType: 'user', entityId: staff.id }),
    );
    return { ok: false, error: 'That passcode isn’t right.', field: 'passcode' };
  }
  await setCookie(staff.id);
  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, { organisationId: staff.organisationId, actor, eventType: 'business_unlocked', entityType: 'organisation', entityId: staff.organisationId }),
  );
  return { ok: true };
}

/**
 * Sets (or resets) the passcode, confirmed with the person's account password. The first owner to do
 * this becomes the Business area's only user.
 */
export async function setBusinessPasscode(password: string, passcode: string, confirm: string): Promise<Result> {
  const staff = await requireStaff();
  if (!canSeeBusiness(staff)) return { ok: false, error: 'The Business area is private to its owner.' };
  const p = passcode.trim();
  if (p.length < 6 || p.length > 32) return { ok: false, error: 'Use 6 to 32 characters.', field: 'passcode' };
  if (/^(.)\1+$/.test(p) || ['123456', '1234567', '12345678', 'password', 'qwerty', '654321'].includes(p.toLowerCase())) return { ok: false, error: 'Pick a passcode that’s harder to guess.', field: 'passcode' };
  if (p !== confirm.trim()) return { ok: false, error: 'The two passcodes don’t match.', field: 'confirm' };
  const db = systemDb();
  const [u] = await db.select().from(users).where(eq(users.id, staff.id)).limit(1);
  if (!u || !(await verifyPassword(password, u.passwordHash))) return { ok: false, error: 'That isn’t your account password.', field: 'password' };
  const hash = await bcrypt.hash(p, 12);
  await withTenant(staff.organisationId, async (tx) => {
    await tx.update(organisations).set({ businessOwnerId: staff.id, businessPasscodeHash: hash }).where(eq(organisations.id, staff.organisationId));
    await recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor({ id: staff.id, name: staff.name }), eventType: 'settings_changed', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { section: 'business.passcode', reset: Boolean(staff.org.businessPasscodeHash) },
    });
  });
  await setCookie(staff.id);
  return { ok: true };
}

export async function lockBusiness() {
  (await cookies()).delete(BUSINESS_COOKIE);
}

/**
 * Leaving a Business page locks the area (pagehide), which used to lock it before "Reconnect Shopify"
 * reached the server. The Stock page (only shown unlocked) hands the button a 10-minute pass instead.
 */
export function shopifyConnectPass(staffId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + 600;
  return `${exp}.${signValue(`shopify-connect:${staffId}:${exp}`)}`;
}

export function validShopifyConnectPass(staffId: string, pass: string | null, now = Date.now()) {
  const [expRaw, sig] = (pass ?? '').split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp) || exp < Math.floor(now / 1000)) return false;
  return safeEqual(sig, signValue(`shopify-connect:${staffId}:${exp}`));
}
