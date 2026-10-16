import { and, eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { z } from 'zod';
import { withTenant } from '@/db';
import { organisations, users, type Organisation, type PerformanceReportSettings } from '@/db/schema';
import { getPerformance } from '../analytics';
import { recordEvent, type Actor } from '../audit';
import { renderPerformanceEmail } from '../email/performance-email';
import { resendApiKey } from '../email/resend-key';
import { fromHeader } from '../email/sender';
import { todayInTz } from '../format';
import { performanceCsv, previousMonth } from '../performance-report';
import { appUrl } from '../tokens';
import { parse } from '../validation';
import { requireRole, ServiceError, type Ctx } from './common';

/** Who gets the monthly report: the listed addresses, or else the owner/admins who sign in. */
export async function reportRecipients(org: Organisation): Promise<string[]> {
  const listed = org.performanceReport.recipients.filter(Boolean);
  if (listed.length) return listed;
  const admins = await withTenant(org.id, (tx) =>
    tx
      .select({ email: users.email, loginEnabled: users.loginEnabled, sharedLogin: users.sharedLogin })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true))),
  );
  return admins.filter((u) => u.loginEnabled && !u.sharedLogin && u.email).map((u) => u.email);
}

export type ReportResult = { month: string; recipients: string[]; simulated: boolean; error?: string };

/** Builds last month's report and emails it with the CSV attached. */
export async function sendPerformanceReport(org: Organisation, actor: Actor, now = new Date()): Promise<ReportResult> {
  const range = previousMonth(org.timezone, now);
  const data = await getPerformance(org, range, now);
  const recipients = await reportRecipients(org);
  if (!recipients.length) return { month: range.monthKey, recipients, simulated: false, error: 'No one to send it to: add an address in Store settings.' };

  const { subject, html, text } = renderPerformanceEmail(org, data, appUrl('/?view=performance&period=30d'));
  const csv = performanceCsv(org, data, todayInTz(org.timezone, now));
  const key = resendApiKey();
  let error: string | undefined;
  if (key) {
    const res = await new Resend(key).emails.send({
      from: fromHeader(org),
      to: recipients,
      replyTo: org.replyToEmail || undefined,
      subject,
      html,
      text,
      attachments: [{ filename: `${org.slug}-performance-${range.monthKey}.csv`, content: Buffer.from(csv, 'utf8') }],
      tags: [{ name: 'cos_report', value: 'monthly_performance' }],
    });
    if (res.error) error = res.error.message;
  } else {
    console.log(`[COS email · simulated] monthly report to=${recipients.join(',')} subject="${subject}"`);
  }

  await withTenant(org.id, (tx) =>
    recordEvent(tx, {
      organisationId: org.id, actor, eventType: error ? 'performance_report_failed' : 'performance_report_sent', entityType: 'organisation',
      entityId: org.id, newValue: { month: range.monthKey, recipients: recipients.length },
      metadata: { simulated: !key, ...(error ? { error } : {}) },
    }),
  );
  return { month: range.monthKey, recipients, simulated: !key, error };
}

/**
 * Daily job hook: once a month has finished, send its report (once). A shop's first run only
 * records the month, so nobody gets a report covering the time before they started.
 */
export async function runMonthlyReport(org: Organisation, actor: Actor, now = new Date()): Promise<string> {
  const settings = org.performanceReport;
  const prev = previousMonth(org.timezone, now).monthKey;
  const save = (s: PerformanceReportSettings) =>
    withTenant(org.id, (tx) => tx.update(organisations).set({ performanceReport: s }).where(eq(organisations.id, org.id)));
  if (!settings.lastSentMonth) {
    await save({ ...settings, lastSentMonth: prev });
    return 'initialised';
  }
  if (!settings.enabled) return 'off';
  if (settings.lastSentMonth >= prev) return 'up to date';
  const r = await sendPerformanceReport(org, actor, now);
  if (r.error) return `failed: ${r.error}`;
  await save({ ...settings, lastSentMonth: prev });
  return `sent ${prev} to ${r.recipients.length}`;
}

const settingsSchema = z.object({
  enabled: z.string().optional().transform((v) => v === 'on' || v === 'true'),
  recipients: z
    .string()
    .default('')
    .transform((v, c) => {
      const list = [...new Set(v.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
      const bad = list.find((e) => !z.string().email().safeParse(e).success);
      if (bad) {
        c.addIssue({ code: 'custom', message: `${bad} isn’t a valid email address` });
        return z.NEVER;
      }
      if (list.length > 10) {
        c.addIssue({ code: 'custom', message: 'Up to 10 addresses' });
        return z.NEVER;
      }
      return list;
    }),
});

export async function updatePerformanceReport(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'admin', 'change the monthly report');
  const v = parse(settingsSchema, raw);
  const next: PerformanceReportSettings = { ...ctx.org.performanceReport, enabled: v.enabled, recipients: v.recipients };
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organisations).set({ performanceReport: next }).where(eq(organisations.id, ctx.org.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { enabled: ctx.org.performanceReport.enabled, recipients: ctx.org.performanceReport.recipients },
      newValue: { enabled: next.enabled, recipients: next.recipients }, metadata: { section: 'performance_report' },
    });
  });
}

/** "Send last month's report now", for checking it or sharing it early. Doesn't affect the monthly schedule. */
export async function sendReportNow(ctx: Ctx) {
  requireRole(ctx, 'admin', 'send the monthly report');
  const r = await sendPerformanceReport(ctx.org, ctx.actor);
  if (r.error) throw new ServiceError(`The report couldn’t be sent: ${r.error}`);
  return r;
}
