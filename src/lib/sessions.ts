import { eq } from 'drizzle-orm';
import { systemDb } from '@/db';
import { sessions } from '@/db/schema';

/** Ends every session for a user (deactivation / password reset). */
export async function revokeUserSessions(userId: string) {
  await systemDb().delete(sessions).where(eq(sessions.userId, userId));
}
