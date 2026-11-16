'use client';

import type { TeamOrder } from '@/db/schema';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

const pounds = (p: number | undefined) => (p === undefined ? undefined : (p / 100).toFixed(2));

/** Set up (or edit) a team order link. */
export function TeamSetupForm({ action, team, defaultTerms }: { action: BoundAction; team?: TeamOrder; defaultTerms: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="title" label="Title (what members see)" required defaultValue={team?.title} placeholder="e.g. Ladies team polo" />
            <Field state={s} name="teamName" label="Team / club" defaultValue={team?.teamName} placeholder="e.g. Wheatley Golf Club Ladies" />
            <Field state={s} name="brand" label="Brand" required defaultValue={team?.brand} />
            <Field state={s} name="product" label="Product" required defaultValue={team?.product} placeholder="e.g. Ladies scallop trim pique polo" />
            <Field state={s} name="colour" label="Colour" defaultValue={team?.colour} />
            <Field
              state={s}
              name="sizes"
              label="Sizes"
              required
              defaultValue={team ? team.sizes.join(', ') : '8, 10, 12, 14, 16, 18, 20'}
              hint="Separated by commas, smallest first"
            />
            <Field state={s} name="price" label="Price (£, inc. VAT)" required inputMode="decimal" defaultValue={pounds(team?.pricePence) ?? '49.99'} />
            <Field
              state={s}
              name="namePrice"
              label="Name option (£ extra)"
              inputMode="decimal"
              defaultValue={pounds(team?.namePricePence) ?? '5.00'}
              hint="Leave empty for no name option"
            />
            <Field state={s} name="namePlacement" label="Where the name goes" defaultValue={team?.namePlacement ?? 'Right chest'} />
            <Field state={s} name="nameMaxLength" label="Longest name (characters)" type="number" min="3" defaultValue={team?.nameMaxLength ?? 20} />
            <Field state={s} name="closesOn" label="Orders close on" type="date" defaultValue={team?.closesOn ?? ''} hint="Optional — the link stops taking orders after this day" />
            <label className="field">
              <span>Photo{team?.imageKey ? ' (leave empty to keep the current one)' : ''}</span>
              <input type="file" name="photo" accept="image/png,image/jpeg,image/webp" />
              <span className="hint">JPG, PNG or WebP, up to 4 MB</span>
            </label>
            <Field
              state={s}
              name="description"
              label="What’s included"
              textarea
              wide
              defaultValue={team?.description ?? 'Includes the club crest embroidered on the left chest.'}
            />
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
