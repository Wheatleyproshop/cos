import type { Metadata } from 'next';
import Link from 'next/link';
import { checkResetToken } from '@/lib/password-reset';
import { ResetForm } from './reset-form';

export const metadata: Metadata = { title: 'Choose a new password', robots: { index: false } };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = await checkResetToken(token);
  return (
    <main className="authwrap" style={{ margin: 0, maxWidth: 'none' }}>
      <div className="authcard">
        <div className="brand">
          COS<span>.</span>
        </div>
        <div className="eyebrow" style={{ marginTop: 4 }}>
          CHOOSE A NEW PASSWORD
        </div>
        {check.ok ? (
          <>
            <p style={{ marginBottom: 0 }}>Hi {check.name.split(' ')[0]}, choose a new password for your account.</p>
            <ResetForm token={token} />
          </>
        ) : (
          <>
            <div className="notice warn" style={{ marginBottom: 0 }}>
              <b>This link has expired or was already used</b>
              Reset links work once and last 1 hour.
            </div>
            <p style={{ marginBottom: 0 }}>
              <Link href="/forgot">Send a new link</Link> · <Link href="/login">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
