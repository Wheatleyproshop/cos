'use server';

import { headers } from 'next/headers';
import type { FormState } from '@/lib/action-utils';
import { ServiceError } from '@/lib/services/common';
import { submitOrderRequest } from '@/lib/services/order-requests';

export async function submitOrderRequestAction(slug: string, _: FormState, fd: FormData): Promise<FormState> {
  // Bots fill in every field; people never see this one.
  if (String(fd.get('website') ?? '')) return { ok: true, message: 'Thank you — we’ve received your request.' };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string') raw[k] = v;
  try {
    const h = await headers();
    const q = await submitOrderRequest(slug, raw, { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null });
    return {
      ok: true,
      message: `Thank you — we’ve received your request (reference ${q.quoteNumber}). We’ll check price and availability and come back to you with a quote, usually within one working day. Nothing is ordered until you approve it. A confirmation is on its way to your inbox.`,
    };
  } catch (e) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) values[k] = String(v);
    if (e instanceof ServiceError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors, values };
    console.error('[COS order request]', e);
    return { ok: false, error: 'Sorry, something went wrong sending your request. Please try again or contact the shop.', values };
  }
}
