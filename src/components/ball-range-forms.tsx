'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormState } from '@/lib/action-utils';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';
import { BrandSelect } from './order-forms';

type BallValues = { brand: string; name: string; colour: string; price: string; minDozens: string; leadTimeDays: string };

/** Add or edit a ball. */
function BallForm({
  action, values, submitLabel, onSaved, brands,
}: { action: BoundAction; values?: BallValues; submitLabel: string; onSaved?: () => void; brands: string[] }) {
  return (
    <ActionForm action={action} resetOnSuccess={!values}>
      {(s) => (
        <>
          <OnSaved state={s} run={onSaved} />
          <div className="fields">
            <BrandSelect brands={brands} defaultValue={values?.brand} state={s} />
            <Field state={s} name="name" label="Model" required placeholder="e.g. Pro V1" defaultValue={values?.name} />
            <Field state={s} name="pricePerDozenPence" label="Price per dozen incl. printing (GBP)" required inputMode="decimal" defaultValue={values?.price} />
            <label className="field">
              <span>Ball colour</span>
              <input type="color" name="colour" defaultValue={values?.colour ?? '#ffffff'} style={{ height: 40, padding: 2 }} />
            </label>
            <Field state={s} name="minDozens" label="Minimum dozens" type="number" min="1" defaultValue={values?.minDozens ?? '1'} />
            <Field state={s} name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue={values?.leadTimeDays ?? '14'} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className={values ? 'btn primary' : 'btn'}>{submitLabel}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

function OnSaved({ state, run }: { state: FormState; run?: () => void }) {
  useEffect(() => {
    if (state?.ok) run?.();
  }, [state, run]);
  return null;
}

export function AddBallForm({ action, brands }: { action: BoundAction; brands: string[] }) {
  return <BallForm action={action} submitLabel="Add ball" brands={brands} />;
}

/** "Edit" button that opens the ball's details in a pop-up. */
export function EditBallButton({ action, values, label, brands }: { action: BoundAction; values: BallValues; label: string; brands: string[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [n, setN] = useState(0); // fresh form each time it opens
  const close = useCallback(() => ref.current?.close(), []);
  return (
    <>
      <button
        type="button"
        className="btn small"
        aria-label={`Edit ${label}`}
        onClick={() => {
          setN((x) => x + 1);
          ref.current?.showModal();
        }}
      >
        Edit
      </button>
      <dialog ref={ref} className="editdialog" aria-label={`Edit ${label}`}>
        <div className="editdialog-head">
          <h2>Edit {label}</h2>
          <button type="button" className="btn small" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <BallForm key={n} action={action} values={values} submitLabel="Save changes" onSaved={close} brands={brands} />
      </dialog>
    </>
  );
}

/** Inline price editor for one ball. */
export function BallPriceForm({ action, value }: { action: BoundAction; value: string }) {
  return <InlinePriceForm action={action} value={value} name="pricePerDozenPence" label="Price per dozen" />;
}

/** A small "amount + Save" form used in catalogue tables. */
export function InlinePriceForm({
  action, value, name, label, perClub,
}: { action: BoundAction; value: string; name: string; label: string; perClub?: boolean }) {
  return (
    <ActionForm action={action} className="inlineform">
      {(s) => (
        <>
          <input name={name} defaultValue={s?.values?.[name] ?? value} inputMode="decimal" aria-label={label} style={{ width: 90 }} />
          {perClub !== undefined ? (
            <label className="perclub" title="Multiply by the number of clubs in an iron set">
              <input type="checkbox" name="perClub" defaultChecked={perClub} /> per club
            </label>
          ) : null}
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
