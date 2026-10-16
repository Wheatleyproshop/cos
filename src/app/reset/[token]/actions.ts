'use server';

import { redirect } from 'next/navigation';
import { completePasswordReset } from '@/lib/password-reset';

export async function resetAction(token: string, _: { error?: string } | null, fd: FormData) {
  const password = String(fd.get('password') ?? '');
  if (password !== String(fd.get('confirm') ?? '')) return { error: 'The two passwords don’t match.' };
  const res = await completePasswordReset(token, password);
  if (!res.ok) return { error: res.error };
  redirect('/login?reset=1');
}
