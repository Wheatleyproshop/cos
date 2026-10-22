'use server';

import { headers } from 'next/headers';
import type { FormState } from '@/lib/action-utils';
import { ServiceError } from '@/lib/services/common';
import { submitBallDesign } from '@/lib/services/ball-printing';

export async function submitDesignAction(slug: string, _: FormState, fd: FormData): Promise<FormState> {
  // Bots fill in every field; people never see this one.
  if (String(fd.get('website') ?? '')) return { ok: true, message: 'Thank you — we’ve received your design.' };
  const file = (name: string) => {
    const v = fd.get(name);
    return v instanceof File && v.size ? v : null;
  };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string') raw[k] = v;
  raw.textLines = fd.getAll('textLines').map(String);
  try {
    const h = await headers();
    const q = await submitBallDesign(slug, raw, { logo: file('logo'), proof: file('proof') }, { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null });
    return { ok: true, message: `Thank you — we’ve received your design (reference ${q.quoteNumber}). We’ll check it over and be in touch shortly before anything goes into print. A confirmation is on its way to your inbox.` };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors };
    console.error('[COS ball design]', e);
    return { ok: false, error: 'Sorry, something went wrong sending your design. Please try again or contact the shop.' };
  }
}
