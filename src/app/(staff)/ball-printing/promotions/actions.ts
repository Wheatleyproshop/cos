'use server';

import { redirect } from 'next/navigation';
import { act, type FormState } from '@/lib/action-utils';
import { createBallPromotion, setBallPromotionClosed, updateBallPromotion } from '@/lib/services/ball-promotions';

const images = (fd: FormData) => {
  const f = (n: string) => {
    const v = fd.get(n);
    return v instanceof File && v.size > 0 ? v : null;
  };
  return { banner: f('banner'), feature: f('feature') };
};
const fields = (fd: FormData) => {
  const raw: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$')) raw[k] = v;
  return raw;
};

export async function createPromotionAction(_: FormState, fd: FormData): Promise<FormState> {
  let id = '';
  const res = await act('manager', async (ctx) => {
    id = (await createBallPromotion(ctx, fields(fd), images(fd))).id;
    return 'Promotion link created.';
  }, fd);
  if (res?.ok && id) redirect(`/ball-printing/promotions/${id}`);
  return res;
}

export async function updatePromotionAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  return act('manager', async (ctx) => {
    await updateBallPromotion(ctx, id, fields(fd), images(fd));
    return 'Saved. The promotion page shows the new details straight away.';
  }, fd);
}

export async function closePromotionAction(id: string, closed: boolean): Promise<FormState> {
  return act('manager', async (ctx) => {
    await setBallPromotionClosed(ctx, id, closed);
    return closed ? 'Closed: the page no longer takes designs.' : 'Reopened.';
  });
}
