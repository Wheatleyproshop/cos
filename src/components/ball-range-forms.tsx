'use client';

import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

export function AddBallForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="brand" label="Brand" required placeholder="e.g. Titleist" />
            <Field state={s} name="name" label="Model" required placeholder="e.g. Pro V1" />
            <Field state={s} name="pricePerDozenPence" label="Price per dozen incl. printing (GBP)" required inputMode="decimal" />
            <label className="field">
              <span>Ball colour</span>
              <input type="color" name="colour" defaultValue="#ffffff" style={{ height: 40, padding: 2 }} />
            </label>
            <Field state={s} name="minDozens" label="Minimum dozens" type="number" min="1" defaultValue="1" />
            <Field state={s} name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue="14" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Add ball</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** Inline price editor for one ball. */
export function BallPriceForm({ action, value }: { action: BoundAction; value: string }) {
  return <InlinePriceForm action={action} value={value} name="pricePerDozenPence" label="Price per dozen" />;
}

/** A small "amount + Save" form used in catalogue tables. */
export function InlinePriceForm({ action, value, name, label }: { action: BoundAction; value: string; name: string; label: string }) {
  return (
    <ActionForm action={action} className="inlineform">
      {(s) => (
        <>
          <input name={name} defaultValue={s?.values?.[name] ?? value} inputMode="decimal" aria-label={label} style={{ width: 90 }} />
          <Submit className="btn small" pendingText="…">Save</Submit>
          {s?.error ? <span className="error">{s.error}</span> : s?.ok ? <span className="muted">Saved</span> : null}
        </>
      )}
    </ActionForm>
  );
}

export function SetupFeeForm({ action, value }: { action: BoundAction; value: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field
              state={s}
              name="ballSetupFeePence"
              label="Artwork setup fee per order (GBP)"
              inputMode="decimal"
              defaultValue={value}
              hint="Added to each print quote. Staff can change it per quote. Use 0.00 for none."
            />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Save</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** Upload or replace a ball's product photo; submits as soon as a file is chosen. */
export function BallPhotoForm({ action, photoUrl, label }: { action: BoundAction; photoUrl: string | null; label: string }) {
  return (
    <ActionForm action={action} className="bp-photoform" encType="multipart/form-data">
      {(s) => (
        <>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt={`Photo of ${label}`} width={44} height={44} />
          ) : (
            <span className="bp-nophoto" aria-hidden="true">No photo</span>
          )}
          <label className="btn small">
            {photoUrl ? 'Replace photo' : 'Add photo'}
            <input
              type="file"
              name="photo"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
            />
          </label>
          {s?.error ? <span className="error">{s.error}</span> : null}
        </>
      )}
    </ActionForm>
  );
}
