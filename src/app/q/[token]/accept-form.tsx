'use client';

import { useActionState } from 'react';
import { acceptQuoteAction } from './actions';

export function AcceptForm({ token, defaultName, total, payFirst = false }: { token: string; defaultName: string; total: string; payFirst?: boolean }) {
  const [state, action, pending] = useActionState(acceptQuoteAction.bind(null, token), null);
  return (
    <form action={action} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
      {state?.error ? (
        <div className="notice error" role="alert" style={{ margin: 0 }}>
          {state.error}
        </div>
      ) : null}
      {state?.message ? (
        <div className="notice" role="status" style={{ margin: 0 }}>
          {state.message}
        </div>
      ) : null}
      <label className="field">
        <span>Your full name</span>
        <input name="acceptedName" required defaultValue={defaultName} autoComplete="name" />
      </label>
      <label className="check">
        <input type="checkbox" name="agree" required /> I approve this specification and price of {total}, and agree to the terms above.
      </label>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Approving…' : payFirst ? 'Approve and pay securely' : 'Approve quote and place order'}
      </button>
    </form>
  );
}
