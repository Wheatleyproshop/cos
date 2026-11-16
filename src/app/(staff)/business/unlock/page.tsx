import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PasscodeSetupForm, UnlockForm } from '@/components/business-ui';
import { PageHeader } from '@/components/views';
import { requireStaff } from '@/lib/auth';
import { BUSINESS_IDLE_MINUTES, businessUnlocked, canSeeBusiness } from '@/lib/business-lock';
import { setPasscodeAction, unlockAction } from '../actions';

export const metadata: Metadata = { title: 'Business' };

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const staff = await requireStaff();
  if (!canSeeBusiness(staff)) redirect('/');
  const { next, reset } = await searchParams;
  const to = next?.startsWith('/business') ? next : '/business/adviser';
  if (!reset && (await businessUnlocked(staff))) redirect(to);
  const setUp = !staff.org.businessPasscodeHash;
  return (
    <>
      <PageHeader staff={staff} title="Business." sub="Private to you: bank, payroll, staff records, stock and tax." actions={<span />} />
      <section className="panel biz-unlock">
        <div className="biz-lockicon" aria-hidden="true">
          🔒
        </div>
        {setUp || reset ? (
          <>
            <h2>{setUp ? 'Set your Business passcode' : 'Reset your Business passcode'}</h2>
            <p className="muted">
              {setUp
                ? 'Only you will be able to open the Business area — it disappears for everyone else, including other owner accounts. '
                : ''}
              You’ll type this passcode every time you open it. It locks again when you leave the area, close the tab, sign out, or after {BUSINESS_IDLE_MINUTES} minutes
              without use.
            </p>
            <PasscodeSetupForm action={setPasscodeAction} reset={!setUp} />
            {reset ? (
              <p className="muted small">
                <Link href="/business/unlock">Back</Link>
              </p>
            ) : null}
          </>
        ) : (
          <>
            <h2>Enter your Business passcode</h2>
            <p className="muted">Private to you. It locks again as soon as you leave. Every visit is recorded in the history.</p>
            <UnlockForm action={unlockAction} next={to} />
            <p className="muted small" style={{ marginBottom: 0 }}>
              <Link href="/business/unlock?reset=1">Forgotten it? Reset with your account password</Link>
            </p>
          </>
        )}
      </section>
    </>
  );
}
