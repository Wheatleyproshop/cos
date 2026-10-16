'use client';

import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

/** Admin-only: send the template being previewed to a real inbox, through the live email provider. */
export function TestEmailForm({ action, defaultTo }: { action: BoundAction; defaultTo: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <div style={{ marginTop: 12 }}>
          <div className="inline-form">
            <Field state={s} name="to" label="Send a test of this email to" type="email" required defaultValue={defaultTo} />
            <Submit className="btn" pendingText="Sending…">
              Send test email
            </Submit>
          </div>
          <FormMessage state={s} />
        </div>
      )}
    </ActionForm>
  );
}
