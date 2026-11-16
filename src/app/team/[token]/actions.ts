'use server';

import { headers } from 'next/headers';
import type { FormState } from '@/lib/action-utils';
import { money } from '@/lib/format';
import { ServiceError } from '@/lib/services/common';
import { submitTeamOrder } from '@/lib/services/team-orders';

export async function submitTeamOrderAction(token: string, _: FormState, fd: FormData): Promise<FormState> {
  // Bots fill in every field; people never see this one.
  if (String(fd.get('website') ?? '')) return { ok: true, message: 'Thank you — your order has been placed.' };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string') raw[k] = v;
  try {
    const h = await headers();
    const r = await submitTeamOrder(token, raw, { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null });
    return {
      ok: true,
      message: `Your order number is ${r.order.orderNumber}: ${r.lines.map((l) => `${l.product} (size ${l.size})`).join(', ')}${r.printedName ? `, with “${r.printedName}”` : ''} — ${money(r.total)}. A confirmation is on its way to your inbox, and we’ll let you know when it’s ready to collect.`,
    };
  } catch (e) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) values[k] = String(v);
    if (e instanceof ServiceError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors, values };
    console.error('[COS team order]', e);
    return { ok: false, error: 'Sorry, something went wrong placing your order. Please try again or contact the shop.', values };
  }
}
