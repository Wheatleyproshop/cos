'use server';

import { requestPasswordReset } from '@/lib/password-reset';

export async function forgotAction(_: { sent?: boolean } | null, fd: FormData) {
  try {
    await requestPasswordReset(String(fd.get('email') ?? ''));
  } catch (e) {
    console.error('[COS password reset]', e);
  }
  // Same answer whether or not the address has an account.
  return { sent: true };
}
