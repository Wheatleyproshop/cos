'use client';

import { useActionState } from 'react';
import { acceptQuoteAction } from './actions';

export function AcceptForm({ token, defaultName, total }: { token: string; defaultName: string; total: string }) {
  const [state, action, pending] = useActionState(acceptQuoteAction.bind(null, token), null);
  return (
    <form action={action} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
      {state?.error ? (
        <div className="notice error" role="alert" style={{ margin: 0 }}>
          {state.error}
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
        {pending ? 'Approving…' : 'Approve quote and place order'}
      </button>
    </form>
  );
}
