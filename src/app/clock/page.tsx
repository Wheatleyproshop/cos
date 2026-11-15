import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ClockScreen } from '@/components/clock-screen';
import { getStaff } from '@/lib/auth';
import { clockBoard } from '@/lib/services/business/staff';
import { clockAction } from './actions';

export const metadata: Metadata = { title: 'Clock in / out' };

/** The shop's clock-in screen. Works on a shared shop login without picking a member first. */
export default async function ClockPage() {
  const staff = await getStaff();
  if (!staff) redirect('/login');
  const people = await clockBoard(staff.organisationId);
  return <ClockScreen storeName={staff.org.storeName} people={people.map((p) => ({ ...p, inSince: p.inSince?.toISOString() ?? null }))} action={clockAction} />;
}
