'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import type { FormState } from '@/lib/action-utils';
import { ctxFor, formValues } from '@/lib/action-utils';
import { lockBusiness, requireBusiness, unlockBusiness } from '@/lib/business-lock';
import { ServiceError, type Ctx } from '@/lib/services/common';
import type { Staff } from '@/lib/auth';
import { saveStaffRecord, setClockPin } from '@/lib/services/business/staff';
import { addRotaShift, addTimeEntry, copyRotaWeek, removeRotaShift, removeTimeEntry, updateTimeEntry } from '@/lib/services/business/time';
import { attachPayslipFile, createPayRun, finalisePayRun, updatePayslip } from '@/lib/services/business/payroll';
import { removeStatement, setCategory, uploadBankStatement } from '@/lib/services/business/bank';
import { importStockFile, removeStockSnapshot } from '@/lib/services/business/stock';

/** Every Business action: owner, unlocked, and renews the 15-minute lock. */
async function biz(fn: (ctx: Ctx, staff: Staff) => Promise<string | { message?: string; url?: string } | void>, fd?: FormData): Promise<FormState> {
  try {
    const staff = await requireBusiness({ renew: true });
    const res = await fn(ctxFor(staff), staff);
    revalidatePath('/business', 'layout');
    if (typeof res === 'string') return { ok: true, message: res };
    return { ok: true, ...(res ?? {}) };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ServiceError) return { error: e.message, fieldErrors: e.fieldErrors, values: fd ? formValues(fd) : undefined };
    console.error('[COS business]', e);
    return { error: 'Something went wrong. Nothing has been changed.', values: fd ? formValues(fd) : undefined };
  }
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function unlockAction(_: FormState, fd: FormData): Promise<FormState> {
  const r = await unlockBusiness(String(fd.get('password') ?? ''));
  if (!r.ok) return { error: r.error };
  const next = str(fd, 'next');
  redirect(next.startsWith('/business') ? next : '/business');
}

export async function lockAction(): Promise<FormState> {
  await lockBusiness();
  redirect('/');
}

/** Called by the page every few minutes while the owner is active, to keep it unlocked. */
export async function renewAction(): Promise<boolean> {
  try {
    await requireBusiness({ renew: true });
    return true;
  } catch (e) {
    unstable_rethrow(e);
    return false;
  }
}

/* Staff */
export async function saveStaffAction(userId: string, includeSensitive: boolean, _: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await saveStaffRecord(ctx, userId, formValues(fd), { includeSensitive });
    return 'Saved.';
  }, fd);
}
export async function setPinAction(userId: string, _: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await setClockPin(ctx, userId, str(fd, 'pin'));
    return str(fd, 'pin') ? 'PIN set — they can now clock in.' : 'PIN removed.';
  }, fd);
}

/* Time & rota */
export async function addEntryAction(_: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await addTimeEntry(ctx, { userId: str(fd, 'userId'), date: str(fd, 'date'), start: str(fd, 'start'), end: str(fd, 'end'), breakMinutes: str(fd, 'breakMinutes'), note: str(fd, 'note') });
    return 'Shift added.';
  }, fd);
}
export async function updateEntryAction(entryId: string, _: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await updateTimeEntry(ctx, entryId, { date: str(fd, 'date'), start: str(fd, 'start'), end: str(fd, 'end'), breakMinutes: str(fd, 'breakMinutes'), note: str(fd, 'note') });
    return 'Shift updated (the original is kept on the history).';
  }, fd);
}
export async function removeEntryAction(entryId: string) {
  return biz(async (ctx) => {
    await removeTimeEntry(ctx, entryId);
    return 'Shift removed.';
  });
}
export async function addShiftAction(_: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await addRotaShift(ctx, { userId: str(fd, 'userId'), date: str(fd, 'date'), start: str(fd, 'start'), end: str(fd, 'end'), note: str(fd, 'note') });
    return 'Added to the rota.';
  }, fd);
}
export async function removeShiftAction(shiftId: string) {
  return biz(async (ctx) => {
    await removeRotaShift(ctx, shiftId);
    return 'Removed from the rota.';
  });
}
export async function copyRotaAction(week: string) {
  return biz(async (ctx) => {
    const n = await copyRotaWeek(ctx, week);
    return n ? `Copied ${n} shift${n === 1 ? '' : 's'} from last week.` : 'Nothing to copy from last week.';
  });
}

/* Payroll */
export async function createPayRunAction(_: FormState, fd: FormData) {
  return biz(async (ctx) => {
    const run = await createPayRun(ctx, { periodStart: str(fd, 'periodStart'), periodEnd: str(fd, 'periodEnd'), payDate: str(fd, 'payDate') });
    redirect(`/business/payroll/${run.id}`);
  }, fd);
}
export async function updatePayslipAction(payslipId: string, _: FormState, fd: FormData) {
  return biz(async (ctx) => {
    await updatePayslip(ctx, payslipId, formValues(fd));
    const file = fd.get('file');
    if (file instanceof File && file.size) await attachPayslipFile(ctx, payslipId, file);
    return 'Saved.';
  }, fd);
}
export async function finalisePayRunAction(runId: string) {
  return biz(async (ctx) => {
    await finalisePayRun(ctx, runId);
    return 'Pay run finalised and locked.';
  });
}

/* Bank */
export async function uploadStatementAction(_: FormState, fd: FormData) {
  return biz(async (ctx) => {
    const file = fd.get('file');
    if (!(file instanceof File) || !file.size) throw new ServiceError('Choose your statement CSV file.', { file: 'Choose a file' });
    const r = await uploadBankStatement(ctx, file, str(fd, 'accountName'));
    return `Added ${r.added} transaction${r.added === 1 ? '' : 's'} (${r.from} to ${r.to})${r.duplicates ? `; ${r.duplicates} already uploaded were skipped` : ''}.`;
  }, fd);
}
export async function removeStatementAction(statementId: string) {
  return biz(async (ctx) => {
    await removeStatement(ctx, statementId);
    return 'Statement removed from the figures.';
  });
}
export async function setCategoryAction(txId: string, category: string, remember: boolean) {
  return biz(async (ctx) => {
    const n = await setCategory(ctx, txId, category, remember);
    return remember && n > 1 ? `Updated ${n} similar transactions — new ones will be sorted the same way.` : 'Updated.';
  });
}

/* Stock */
export async function uploadStockAction(_: FormState, fd: FormData) {
  return biz(async (ctx) => {
    const file = fd.get('file');
    if (!(file instanceof File) || !file.size) throw new ServiceError('Choose the CSV file.', { file: 'Choose a file' });
    const r = await importStockFile(ctx, file, str(fd, 'takenOn'));
    if (r.kind === 'catalogue') return `Product list updated: ${r.rows.toLocaleString('en-GB')} variants (${r.withCost.toLocaleString('en-GB')} with a cost price). Now upload an inventory export for quantities.`;
    return `Stock count added: ${r.units.toLocaleString('en-GB')} items across ${r.lines.toLocaleString('en-GB')} lines${r.unmatched ? ` — ${r.unmatched} couldn’t be matched to a cost price (upload a fresh product export to fix)` : ''}.`;
  }, fd);
}
export async function removeStockAction(id: string) {
  return biz(async (ctx) => {
    await removeStockSnapshot(ctx, id);
    return 'Stock count removed.';
  });
}
