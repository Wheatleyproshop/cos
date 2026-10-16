'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { ctxFor } from '@/lib/action-utils';
import { requireStaff } from '@/lib/auth';
import { ServiceError } from '@/lib/services/common';
import { importCustomers, type ImportResult, type ImportRow } from '@/lib/services/customer-import';

export type ImportState =
  | { stage: 'preview'; result: ImportResult; columns: Record<string, string>; sample: ImportRow[]; skippedLines: number[] }
  | { stage: 'done'; result: ImportResult }
  | { stage: 'error'; error: string }
  | null;

export async function importCustomersAction(_: ImportState, fd: FormData): Promise<ImportState> {
  try {
    const staff = await requireStaff('manager');
    const file = fd.get('file');
    const text = file instanceof File ? await file.text() : String(fd.get('csv') ?? '');
    if (!text.trim()) return { stage: 'error', error: 'Choose a CSV file first.' };
    const dryRun = fd.get('confirm') !== 'yes';
    const { plan, ...result } = await importCustomers(ctxFor(staff), text, { dryRun });
    if (dryRun) {
      return {
        stage: 'preview',
        result,
        columns: plan.columns as Record<string, string>,
        sample: plan.rows.slice(0, 8),
        skippedLines: plan.skipped.slice(0, 20).map((s) => s.line),
      };
    }
    revalidatePath('/', 'layout');
    return { stage: 'done', result };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ServiceError) return { stage: 'error', error: e.message };
    console.error('[COS import]', e);
    return { stage: 'error', error: 'Something went wrong reading that file. Nothing was imported.' };
  }
}
