import 'server-only';
import bcrypt from 'bcryptjs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { systemDb } from '@/db';
import { organisations, sessions, users, type Organisation } from '@/db/schema';
import { hashToken, newToken } from './tokens';

export const SESSION_COOKIE = 'cos_session';
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export type Role = 'admin' | 'manager' | 'staff';
export const ROLE_LABELS: Record<Role, string> = { admin: 'Owner / Admin', manager: 'Manager', staff: 'Staff' };
const RANK: Record<Role, number> = { staff: 1, manager: 2, admin: 3 };

export type Staff = {
  id: string;
  name: string;
  email: string;
  role: Role;
  organisationId: string;
  org: Organisation;
};

export function hasRole(staff: Pick<Staff, 'role'>, min: Role): boolean {
  return RANK[staff.role] >= RANK[min];
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Current staff member for this request, or null. Cached per request. */
export const getStaff = cache(async (): Promise<Staff | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = systemDb();
  const [row] = await db
    .select({ user: users, org: organisations })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organisations, eq(organisations.id, sessions.organisationId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.active) return null;
  return {
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    organisationId: row.org.id,
    org: row.org,
  };
});

/** Use at the top of every staff page and server action. */
export async function requireStaff(min: Role = 'staff'): Promise<Staff> {
  const staff = await getStaff();
  if (!staff) redirect('/login');
  if (!hasRole(staff, min)) throw new ForbiddenError(`This action needs the ${ROLE_LABELS[min]} role.`);
  return staff;
}

export class ForbiddenError extends Error {
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

let dummyHash: Promise<string> | undefined;

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(emailInput: string, password: string): Promise<LoginResult> {
  const email = emailInput.trim().toLowerCase();
  const generic = 'That email and password combination was not recognised.';
  if (!email || !password) return { ok: false, error: 'Enter your email and password.' };
  const db = systemDb();
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user || !user.active) {
    // Spend the same time as a real check so response timing doesn't reveal which emails exist.
    dummyHash ??= bcrypt.hash('cos-timing-equaliser', 12);
    await bcrypt.compare(password, await dummyHash);
    return { ok: false, error: generic };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, error: 'Too many failed attempts. Try again in a few minutes or ask an admin to reset your password.' };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    return { ok: false, error: generic };
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const ua = (await headers()).get('user-agent')?.slice(0, 300) ?? null;
  await db.insert(sessions).values({
    userId: user.id,
    organisationId: user.organisationId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: ua,
  });
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return { ok: true };
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await systemDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

/** Ends every session for a user (deactivation / password reset). */
export async function revokeUserSessions(userId: string) {
  await systemDb().delete(sessions).where(eq(sessions.userId, userId));
}
