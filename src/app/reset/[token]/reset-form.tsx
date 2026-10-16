'use client';

import { useActionState } from 'react';
import { resetAction } from './actions';

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetAction.bind(null, token), null);
  return (
    <form action={action} style={{ display: 'grid', gap: 14, marginTop: 18 }}>
      {state?.error ? (
        <div className="notice error" role="alert" style={{ margin: 0 }}>
          {state.error}
        </div>
      ) : null}
      <label className="field">
        <span>New password</span>
        <input name="password" type="password" autoComplete="new-password" required minLength={10} autoFocus />
        <span className="hint">At least 10 characters</span>
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input name="confirm" type="password" autoComplete="new-password" required minLength={10} />
      </label>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  );
}
