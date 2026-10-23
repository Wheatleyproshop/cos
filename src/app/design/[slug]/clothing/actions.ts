'use server';

import { headers } from 'next/headers';
import type { FormState } from '@/lib/action-utils';
import { ServiceError } from '@/lib/services/common';
import { submitCrestDesign } from '@/lib/services/cresting';

export async function submitCrestDesignAction(slug: string, _: FormState, fd: FormData): Promise<FormState> {
  // Bots fill in every field; people never see this one.
  if (String(fd.get('website') ?? '')) return { ok: true, message: 'Thank you — we’ve received your design.' };
  const file = (name: string) => {
    const v = fd.get(name);
    return v instanceof File && v.size ? v : null;
  };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string') raw[k] = v;
  try {
    const h = await headers();
    const q = await submitCrestDesign(
      slug,
      raw,
      { front: file('front'), back: file('back'), logos: [file('logo0'), file('logo1'), file('logo2')], proof: file('proof') },
      { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null },
    );
    return {
      ok: true,
      message: `Thank you — we’ve received your design (reference ${q.quoteNumber}). We’ll check the artwork, confirm the price and be in touch shortly before anything is made. A confirmation is on its way to your inbox.`,
    };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors };
    console.error('[COS cresting design]', e);
    return { ok: false, error: 'Sorry, something went wrong sending your design. Please try again or contact the shop.' };
  }
}
