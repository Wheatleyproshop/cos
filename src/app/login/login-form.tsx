'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { loginAction } from './actions';

export function LoginForm({ justReset }: { justReset?: boolean }) {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} style={{ display: 'grid', gap: 14, marginTop: 22 }}>
      {justReset && !state?.error ? (
        <div className="notice" role="status" style={{ margin: 0 }}>
          Password changed. Sign in with your new password.
        </div>
      ) : null}
      {state?.error ? (
        <div className="notice error" role="alert" style={{ margin: 0 }}>
          {state.error}
        </div>
      ) : null}
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="username" required defaultValue={state?.email} autoFocus />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <Link href="/forgot" className="muted" style={{ textAlign: 'center' }}>
        Forgot password?
      </Link>
    </form>
  );
}
