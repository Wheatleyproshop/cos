'use server';

import { redirect } from 'next/navigation';
import { getStaff, listPickableMembers, setActingMember } from '@/lib/auth';

export async function pickMemberAction(memberId: string) {
  const staff = await getStaff();
  if (!staff?.sharedLoginName) redirect('/');
  const members = await listPickableMembers(staff.organisationId);
  if (!members.some((m) => m.id === memberId)) redirect('/who');
  await setActingMember(memberId);
  redirect('/');
}
