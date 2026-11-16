'use server';

import { redirect } from 'next/navigation';
import { act, type FormState } from '@/lib/action-utils';
import { createTeamOrder, MAX_TEAM_ITEMS, setTeamOrderClosed, updateTeamOrder } from '@/lib/services/team-orders';

const fields = (fd: FormData) => {
  const raw: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$')) raw[k] = v;
  return raw;
};
const photo = (fd: FormData) =>
  Array.from({ length: MAX_TEAM_ITEMS }, (_, n) => {
    const f = fd.get(`item${n}_photo`);
    return f instanceof File && f.size > 0 ? f : null;
  });

export async function createTeamOrderAction(_: FormState, fd: FormData): Promise<FormState> {
  let id = '';
  const res = await act('manager', async (ctx) => {
    id = (await createTeamOrder(ctx, fields(fd), photo(fd))).id;
    return 'Team order link created.';
  }, fd);
  if (res?.ok && id) redirect(`/orders/team/${id}`);
  return res;
}

export async function updateTeamOrderAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  return act('manager', async (ctx) => {
    await updateTeamOrder(ctx, id, fields(fd), photo(fd));
    return 'Saved. The link shows the new details straight away.';
  }, fd);
}

export async function closeTeamOrderAction(id: string, closed: boolean): Promise<FormState> {
  return act('manager', async (ctx) => {
    await setTeamOrderClosed(ctx, id, closed);
    return closed ? 'Closed: the link no longer takes orders.' : 'Reopened.';
  });
}
