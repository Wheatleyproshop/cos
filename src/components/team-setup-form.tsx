'use client';

import { useState } from 'react';
import type { TeamOrder } from '@/db/schema';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

const pounds = (p: number | undefined) => (p === undefined ? undefined : (p / 100).toFixed(2));
const LADIES = '8, 10, 12, 14, 16, 18, 20';

/** Set up (or edit) a team order link: the link's details, then one row per garment. */
export function TeamSetupForm({ action, team, defaultTerms, max }: { action: BoundAction; team?: TeamOrder; defaultTerms: string; max: number }) {
  const [rows, setRows] = useState(Math.min(max, Math.max(team ? team.items.length + 1 : 3, 1)));
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="title" label="Title (what members see)" required defaultValue={team?.title} placeholder="e.g. Ladies team kit" />
            <Field state={s} name="teamName" label="Team / club" defaultValue={team?.teamName} placeholder="e.g. Wheatley Golf Club Ladies" />
            <Field state={s} name="brand" label="Brand" required defaultValue={team?.brand} />
            <Field state={s} name="closesOn" label="Orders close on" type="date" defaultValue={team?.closesOn ?? ''} hint="Optional — the link stops taking orders after this day" />
            <Field
              state={s}
              name="description"
              label="What’s included"
              textarea
              wide
              defaultValue={team?.description ?? 'All prices include the club crest embroidered on the left chest.'}
            />
          </div>

          <h3 className="team-setup-h">Garments</h3>
          <p className="muted" style={{ marginTop: 0 }}>Leave a row’s product empty to leave it out (or to remove a garment).</p>
          {Array.from({ length: rows }, (_, n) => {
            const it = team?.items[n];
            return (
              <fieldset key={n} className="team-item-row">
                <legend>Garment {n + 1}</legend>
                <input type="hidden" name={`item${n}_id`} value={it?.id ?? ''} />
                <div className="fields">
                  <Field state={s} name={`item${n}_product`} label="Product" defaultValue={it?.product} placeholder="e.g. Arwen polo" />
                  <Field state={s} name={`item${n}_colour`} label="Colour" defaultValue={it?.colour} />
                  <Field state={s} name={`item${n}_price`} label="Price (£, inc. VAT)" inputMode="decimal" defaultValue={pounds(it?.pricePence)} placeholder="49.99" />
                  <Field state={s} name={`item${n}_sizes`} label="Sizes" defaultValue={it ? it.sizes.join(', ') : LADIES} hint="Separated by commas, smallest first" />
                  <label className="field wide">
                    <span>Photo{it?.imageKey ? ' (leave empty to keep the current one)' : ''}</span>
                    <input type="file" name={`item${n}_photo`} accept="image/png,image/jpeg,image/webp" />
                    {s?.fieldErrors?.[`item${n}_photo`] ? <span className="err">{s.fieldErrors[`item${n}_photo`]}</span> : <span className="hint">JPG, PNG or WebP, up to 4 MB</span>}
                  </label>
                </div>
              </fieldset>
            );
          })}
          {rows < max ? (
            <button type="button" className="btn small" onClick={() => setRows(rows + 1)}>
              + Another garment
            </button>
          ) : null}

          <h3 className="team-setup-h">Name option</h3>
          <div className="fields">
            <Field state={s} name="namePrice" label="Name price (£ extra per garment)" inputMode="decimal" defaultValue={pounds(team?.namePricePence) ?? '5.00'} hint="Leave empty for no name option" />
            <Field state={s} name="namePlacement" label="Where the name goes" defaultValue={team?.namePlacement ?? 'Right chest'} />
            <Field state={s} name="nameMaxLength" label="Longest name (characters)" type="number" min="3" defaultValue={team?.nameMaxLength ?? 20} />
          </div>
          <div className="fields">
            <Field state={s} name="terms" label="Order terms (shown above the accept box)" textarea wide defaultValue={team?.terms ?? defaultTerms} />
          </div>
          <FormMessage state={s} />
          <div className="actions">
            <Submit pendingText="Saving…">{team ? 'Save changes' : 'Create the link'}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
