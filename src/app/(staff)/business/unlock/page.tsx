import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { UnlockForm } from '@/components/business-ui';
import { PageHeader } from '@/components/views';
import { requireStaff } from '@/lib/auth';
import { BUSINESS_IDLE_MINUTES, businessUnlocked } from '@/lib/business-lock';
import { unlockAction } from '../actions';

export const metadata: Metadata = { title: 'Business' };

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.sharedLoginName) redirect('/');
  const { next } = await searchParams;
  const to = next?.startsWith('/business') ? next : '/business';
  if (await businessUnlocked(staff)) redirect(to);
  return (
    <>
      <PageHeader staff={staff} title="Business." sub="Bank, payroll, staff records and how the business is doing." actions={<span />} />
      <section className="panel biz-unlock">
        <div className="biz-lockicon" aria-hidden="true">
          🔒
        </div>
        <h2>Owner only — enter your password to continue</h2>
        <p className="muted">
          This area holds pay, bank and personal details. It locks again after {BUSINESS_IDLE_MINUTES} minutes without use, when you press Lock, or when
          you sign out. Every visit is recorded in the history.
        </p>
        <UnlockForm action={unlockAction} next={to} />
      </section>
    </>
  );
}
