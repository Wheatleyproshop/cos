'use server';

import { revalidatePath } from 'next/cache';
import { staffActor } from '@/lib/audit';
import { getStaff } from '@/lib/auth';
import { clockToggle } from '@/lib/services/business/staff';
import { ServiceError } from '@/lib/services/common';

export type ClockResult = { ok: true; name: string; action: 'in' | 'out'; minutes: number } | { ok: false; error: string };

/** Clock someone in or out from the shop screen. Needs a signed-in COS session on the device (e.g. the shared shop login). */
export async function clockAction(userId: string, pin: string): Promise<ClockResult> {
  const device = await getStaff();
  if (!device) return { ok: false, error: 'This screen has been signed out. Sign in to COS again.' };
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d{4,6}$/.test(pin)) return { ok: false, error: 'Enter your 4–6 digit PIN.' };
  try {
    const r = await clockToggle(device.organisationId, userId, pin, staffActor({ id: device.id, name: `${device.sharedLoginName ?? device.name} (clock screen)` }));
    revalidatePath('/clock');
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, error: e.message };
    console.error('[COS clock]', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
