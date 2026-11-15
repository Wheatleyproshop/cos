import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant } from '@/db';
import { payRuns, payslips, staffProfiles, users } from '@/db/schema';
import { recordEvent } from '../../audit';
import { parseMoneyToPence } from '../../format';
import { storage } from '../../storage';
import { decryptBuffer, encryptBuffer } from '../../tokens';
import { ServiceError, type Ctx } from '../common';
import { addDaysIso, timeEntriesBetween, workedMinutes } from './time';

/**
 * Pay runs done by hand: COS works out basic pay from clocked hours × hourly rate (or the salary for
 * the period), the owner types in tax, NI and pension from HMRC Basic PAYE Tools (which is also how
 * pay is reported to HMRC), and COS produces net pay, payslips and an export. Finalised runs are locked.
 */

const iso = /^\d{4}-\d{2}-\d{2}$/;

/** How much of a year one pay period is: monthly (1/12), or weeks/52. */
export function periodFraction(start: string, end: string) {
  const days = Math.round((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86_400_000) + 1;
  return days >= 28 && days <= 31 ? 1 / 12 : days / 7 / 52;
}

export const netPence = (p: { basicPence: number; holidayPayPence: number; bonusPence: number; taxPence: number; employeeNiPence: number; pensionPence: number; otherDeductionsPence: number }) =>
  p.basicPence + p.holidayPayPence + p.bonusPence - p.taxPence - p.employeeNiPence - p.pensionPence - p.otherDeductionsPence;
export const grossPence = (p: { basicPence: number; holidayPayPence: number; bonusPence: number }) => p.basicPence + p.holidayPayPence + p.bonusPence;

export async function listPayRuns(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const runs = await tx.select().from(payRuns).orderBy(desc(payRuns.periodEnd)).limit(60);
    const slips = runs.length ? await tx.select().from(payslips).where(inArray(payslips.payRunId, runs.map((r) => r.id))) : [];
    return runs.map((r) => {
      const mine = slips.filter((s) => s.payRunId === r.id);
      return {
        ...r, people: mine.length, gross: mine.reduce((n, s) => n + grossPence(s), 0), net: mine.reduce((n, s) => n + netPence(s), 0),
        employerCost: mine.reduce((n, s) => n + grossPence(s) + s.employerNiPence + s.employerPensionPence, 0),
      };
    });
  });
}

/** Starts a pay run with a payslip for everyone employed during the period, basic pay worked out. */
export async function createPayRun(ctx: Ctx, v: { periodStart: string; periodEnd: string; payDate: string }) {
  const errs: Record<string, string> = {};
  if (!iso.test(v.periodStart)) errs.periodStart = 'Pick a date';
  if (!iso.test(v.periodEnd)) errs.periodEnd = 'Pick a date';
  if (!iso.test(v.payDate)) errs.payDate = 'Pick a date';
  if (!errs.periodStart && !errs.periodEnd && v.periodEnd < v.periodStart) errs.periodEnd = 'After the start';
  if (Object.keys(errs).length) throw new ServiceError('Please check the dates.', errs);
  const entries = await timeEntriesBetween(ctx.org.id, v.periodStart, addDaysIso(v.periodEnd, 1), ctx.org.timezone);
  const frac = periodFraction(v.periodStart, v.periodEnd);
  return withTenant(ctx.org.id, async (tx) => {
    const people = await tx
      .select({ u: users, p: staffProfiles })
      .from(users)
      .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.sharedLogin, false), isNull(users.removedAt)));
    const employed = people.filter(({ p }) => (!p.startDate || p.startDate <= v.periodEnd) && (!p.endDate || p.endDate >= v.periodStart));
    if (!employed.length) throw new ServiceError('Add pay details for your team first (Business → Staff).');
    const [run] = await tx.insert(payRuns).values({ organisationId: ctx.org.id, ...v }).returning();
    for (const { u, p } of employed) {
      const minutes = entries.filter((e) => e.e.userId === u.id && e.e.clockOut).reduce((n, e) => n + workedMinutes(e.e), 0);
      const basic = p.payType === 'salary' ? Math.round(p.annualSalaryPence * frac) : Math.round((minutes / 60) * p.hourlyRatePence);
      await tx.insert(payslips).values({
        organisationId: ctx.org.id, payRunId: run.id, userId: u.id, minutesWorked: minutes,
        hourlyRatePence: p.payType === 'hourly' ? p.hourlyRatePence : 0, basicPence: basic,
      });
    }
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'pay_run_created', entityType: 'organisation', entityId: ctx.org.id,
      newValue: { ...v, people: employed.length }, metadata: { payRunId: run.id },
    });
    return run;
  });
}

export async function getPayRun(orgId: string, runId: string) {
  return withTenant(orgId, async (tx) => {
    const [run] = await tx.select().from(payRuns).where(eq(payRuns.id, runId)).limit(1);
    if (!run) return null;
    const slips = await tx
      .select({ s: payslips, name: users.name, jobTitle: staffProfiles.jobTitle, payType: staffProfiles.payType })
      .from(payslips)
      .innerJoin(users, eq(users.id, payslips.userId))
      .leftJoin(staffProfiles, eq(staffProfiles.userId, payslips.userId))
      .where(eq(payslips.payRunId, runId))
      .orderBy(asc(users.name));
    return { run, slips };
  });
}

const MONEY_FIELDS = ['basicPence', 'holidayPayPence', 'bonusPence', 'taxPence', 'employeeNiPence', 'pensionPence', 'otherDeductionsPence', 'employerNiPence', 'employerPensionPence'] as const;

export async function updatePayslip(ctx: Ctx, payslipId: string, raw: Record<string, unknown>) {
  const patch: Record<string, number | string> = {};
  const errs: Record<string, string> = {};
  for (const k of MONEY_FIELDS) {
    const v = String(raw[k] ?? '').trim();
    const p = v === '' ? 0 : parseMoneyToPence(v.replace(/^-/, ''));
    if (p === null) errs[k] = 'An amount, e.g. 120.50';
    else patch[k] = p;
  }
  if (Object.keys(errs).length) throw new ServiceError('Please check the highlighted amounts.', errs);
  patch.notes = String(raw.notes ?? '').trim().slice(0, 500);
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.select({ s: payslips, status: payRuns.status }).from(payslips).innerJoin(payRuns, eq(payRuns.id, payslips.payRunId)).where(eq(payslips.id, payslipId)).limit(1);
    if (!row) throw new ServiceError('Payslip not found.');
    if (row.status === 'finalised') throw new ServiceError('This pay run is finalised and can’t be changed.');
    const next = { ...row.s, ...patch } as typeof row.s;
    if (netPence(next) < 0) throw new ServiceError('Deductions are more than the pay — check the figures.');
    await tx.update(payslips).set({ ...patch, updatedAt: new Date() }).where(eq(payslips.id, payslipId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'payslip_saved', entityType: 'user', entityId: row.s.userId,
      metadata: { payRunId: row.s.payRunId, payslipId },
    });
  });
}

export async function finalisePayRun(ctx: Ctx, runId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [run] = await tx.select().from(payRuns).where(eq(payRuns.id, runId)).limit(1);
    if (!run || run.status === 'finalised') return;
    await tx.update(payRuns).set({ status: 'finalised', finalisedAt: new Date() }).where(eq(payRuns.id, runId));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'pay_run_finalised', entityType: 'organisation', entityId: ctx.org.id, metadata: { payRunId: runId, period: `${run.periodStart} to ${run.periodEnd}` } });
  });
}

/** Attaches a payslip PDF (e.g. from Basic PAYE Tools or an accountant). Stored encrypted. */
export async function attachPayslipFile(ctx: Ctx, payslipId: string, file: File) {
  if (file.type !== 'application/pdf' || file.size > 5 * 1024 * 1024) throw new ServiceError('Upload a PDF of up to 5 MB.');
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== '%PDF') throw new ServiceError('That file isn’t a PDF.');
  const key = `business/${ctx.org.id}/payslips/${payslipId}-${Date.now()}.pdf.enc`;
  await storage().put(key, encryptBuffer(buf), 'application/octet-stream');
  await withTenant(ctx.org.id, async (tx) => {
    const [s] = await tx.select().from(payslips).where(eq(payslips.id, payslipId)).limit(1);
    if (!s) throw new ServiceError('Payslip not found.');
    await tx.update(payslips).set({ fileKey: key, fileName: file.name.slice(0, 120), updatedAt: new Date() }).where(eq(payslips.id, payslipId));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'payslip_file_added', entityType: 'user', entityId: s.userId, metadata: { payslipId, file: file.name } });
  });
}

export async function payslipFile(orgId: string, payslipId: string) {
  const [s] = await withTenant(orgId, (tx) => tx.select().from(payslips).where(eq(payslips.id, payslipId)).limit(1));
  if (!s?.fileKey) return null;
  return { body: decryptBuffer(await storage().get(s.fileKey)), name: s.fileName ?? 'payslip.pdf' };
}

/** The run as a spreadsheet, for the owner's records or an accountant. */
export function payRunCsv(data: NonNullable<Awaited<ReturnType<typeof getPayRun>>>) {
  const g = (p: number) => (p / 100).toFixed(2);
  const head = ['Name', 'Hours', 'Hourly rate', 'Basic', 'Holiday pay', 'Bonus', 'Gross', 'Tax', 'Employee NI', 'Pension', 'Other deductions', 'Net pay', 'Employer NI', 'Employer pension', 'Cost to business'];
  const rows = data.slips.map(({ s, name }) => [
    name, (s.minutesWorked / 60).toFixed(2), g(s.hourlyRatePence), g(s.basicPence), g(s.holidayPayPence), g(s.bonusPence), g(grossPence(s)),
    g(s.taxPence), g(s.employeeNiPence), g(s.pensionPence), g(s.otherDeductionsPence), g(netPence(s)), g(s.employerNiPence), g(s.employerPensionPence),
    g(grossPence(s) + s.employerNiPence + s.employerPensionPence),
  ]);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + [[`Pay run ${data.run.periodStart} to ${data.run.periodEnd} (paid ${data.run.payDate})`], head, ...rows].map((r) => r.map(String).map(esc).join(',')).join('\r\n') + '\r\n';
}
