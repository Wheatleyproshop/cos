'use server';

import { redirect } from 'next/navigation';
import { login } from '@/lib/auth';

export async function loginAction(_: { error?: string } | null, fd: FormData) {
  const res = await login(String(fd.get('email') ?? ''), String(fd.get('password') ?? ''));
  if (!res.ok) return { error: res.error, email: String(fd.get('email') ?? '') };
  redirect('/');
}
