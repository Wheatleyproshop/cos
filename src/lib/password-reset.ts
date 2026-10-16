import 'server-only';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { systemDb } from '@/db';
import { auditEvents, organisations, passwordResets, sessions, users } from '@/db/schema';
import { senderAddress } from './email/sender';
import { resendApiKey } from './email/resend-key';
import { appUrl, hashToken, newToken } from './tokens';

const LINK_MINUTES = 60;
const MAX_PER_HOUR = 3;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function resetEmail(name: string, storeName: string, link: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a202b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;overflow:hidden">
<tr><td style="background:#0e1522;color:#f4f6f9;text-align:center;padding:26px 20px"><div style="font-size:30px;font-weight:800;letter-spacing:-1px">COS<span style="color:#1f7bff">.</span></div><div style="font-size:10px;letter-spacing:6px;color:#c9ced6;margin-top:4px">GOLF</div></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 14px">Reset your password</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 14px">Hi ${esc(name.split(' ')[0] || 'there')},</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 20px">Someone asked to reset the password for your ${esc(storeName)} COS account. If that was you, use the button below. The link works once and expires in ${LINK_MINUTES} minutes.</p>
<a href="${esc(link)}" style="display:inline-block;background:#16233a;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:600">Choose a new password</a>
<p style="font-size:13px;line-height:1.55;margin:22px 0 0;color:#6b6f7b">If you didn’t ask for this, you can ignore this email — your password won’t change.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Reset your password\n\nHi ${name.split(' ')[0] || 'there'},\n\nUse this link to choose a new password for your ${storeName} COS account (works once, expires in ${LINK_MINUTES} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email.`;
  return { html, text };
}

/**
 * Emails a one-time reset link if the address belongs to an active account with its own login.
 * Always completes silently so the form never reveals which emails have accounts.
 */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  const db = systemDb();
  const [row] = await db
    .select({ user: users, org: organisations })
    .from(users)
    .innerJoin(organisations, eq(organisations.id, users.organisationId))
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!row || !row.user.active || !row.user.loginEnabled) return;

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(passwordResets)
    .where(and(eq(passwordResets.userId, row.user.id), gt(passwordResets.createdAt, new Date(Date.now() - 3_600_000))));
  if (n >= MAX_PER_HOUR) return;

  const token = newToken();
  await db.insert(passwordResets).values({
    userId: row.user.id,
    organisationId: row.org.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
  });
  await db.insert(auditEvents).values({
    organisationId: row.org.id, entityType: 'user', entityId: row.user.id, actorType: 'system', actorLabel: 'COS',
    eventType: 'password_reset_requested', metadataJson: { email },
  });

  const link = appUrl(`/reset/${token}`);
  const { html, text } = resetEmail(row.user.name, row.org.storeName, link);
  const key = resendApiKey();
  if (!key) {
    console.info(`[COS password reset · simulated] ${email} → ${link}`);
    return;
  }
  const res = await new Resend(key).emails.send({
    from: `"COS Golf" <${senderAddress(row.org)}>`,
    to: [row.user.email],
    subject: 'Reset your COS password',
    html,
    text,
  });
  if (res.error) console.error('[COS password reset] email failed:', res.error.message);
}

export type ResetCheck = { ok: true; name: string } | { ok: false };

export async function checkResetToken(token: string): Promise<ResetCheck> {
  if (!/^[\w-]{20,100}$/.test(token)) return { ok: false };
  const [row] = await systemDb()
    .select({ name: users.name })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
    .limit(1);
  return row ? { ok: true, name: row.name } : { ok: false };
}

/** Sets the new password, uses up the link and signs the account out everywhere. */
export async function completePasswordReset(token: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (password.length < 10) return { ok: false, error: 'Use at least 10 characters.' };
  if (password.length > 200) return { ok: false, error: 'That password is too long.' };
  if (!/^[\w-]{20,100}$/.test(token)) return { ok: false, error: 'This reset link is not valid.' };
  const db = systemDb();
  return db.transaction(async (tx) => {
    const [reset] = await tx
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .for('update')
      .limit(1);
    if (!reset) return { ok: false, error: 'This reset link has expired or already been used. Ask for a new one.' };
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, reset.id));
    await tx
      .update(users)
      .set({ passwordHash: await bcrypt.hash(password, 12), failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, reset.userId));
    await tx.delete(sessions).where(eq(sessions.userId, reset.userId));
    await tx.insert(auditEvents).values({
      organisationId: reset.organisationId, entityType: 'user', entityId: reset.userId, actorType: 'system', actorLabel: 'Password reset link',
      eventType: 'user_updated', newValueJson: { password: 'reset by email link' },
    });
    return { ok: true };
  });
}
