'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { forgotAction } from './actions';

export function ForgotForm() {
  const [state, action, pending] = useActionState(forgotAction, null);
  if (state?.sent) {
    return (
      <div style={{ marginTop: 18 }}>
        <div className="notice" role="status" style={{ margin: 0 }}>
          <b>Check your email</b>
          If that address has a COS account, we’ve sent a link to choose a new password. It expires in 1 hour.
        </div>
        <p style={{ marginBottom: 0 }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    );
  }
  return (
    <form action={action} style={{ display: 'grid', gap: 14, marginTop: 18 }}>
      <p style={{ margin: 0 }}>Enter the email you sign in with and we’ll send you a link to choose a new password.</p>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="username" required autoFocus />
      </label>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send reset link'}
      </button>
      <Link href="/login" className="muted" style={{ textAlign: 'center' }}>
        Back to sign in
      </Link>
    </form>
  );
}
