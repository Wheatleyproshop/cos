'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ServiceError } from '@/lib/services/common';
import { acceptQuoteByToken } from '@/lib/services/quotes';

export async function acceptQuoteAction(token: string, _: { error?: string } | null, fd: FormData) {
  if (fd.get('agree') !== 'on') return { error: 'Please tick the box to confirm you agree to the terms.' };
  let trackingUrl: string;
  try {
    const h = await headers();
    const res = await acceptQuoteByToken(token, String(fd.get('acceptedName') ?? ''), {
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent')?.slice(0, 300) ?? null,
    });
    trackingUrl = res.trackingUrl;
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message };
    console.error('[COS quote acceptance]', e);
    return { error: 'Sorry, something went wrong. Nothing has been approved — please try again or contact the shop.' };
  }
  redirect(new URL(trackingUrl).pathname + '?approved=1');
}
