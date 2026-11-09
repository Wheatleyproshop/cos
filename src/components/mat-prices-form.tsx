'use client';

import { penceToInput } from '@/lib/format';
import type { MatPrices } from '@/lib/mat-engraving';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

export function MatPricesForm({ action, prices }: { action: BoundAction; prices: MatPrices }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            {prices.mats.map((m) => (
              <Field key={m.key} state={s} name={m.key} label={`${m.name}, engraved (£ each)`} inputMode="decimal" defaultValue={penceToInput(m.pricePence)} />
            ))}
            <Field state={s} name="caseDealPence" label="Carry case deal: mat + carry case + engraving (£)" inputMode="decimal" defaultValue={penceToInput(prices.caseDealPence)} hint="0.00 to not offer the deal." />
            <Field state={s} name="lip" label="Own mat: front lip engraving, each (£)" inputMode="decimal" defaultValue={penceToInput(prices.positions.lip)} />
            <Field state={s} name="underside" label="Own mat: underside engraving, each (£)" inputMode="decimal" defaultValue={penceToInput(prices.positions.underside)} />
            <Field state={s} name="setupFeePence" label="Setup fee per job (£)" inputMode="decimal" defaultValue={penceToInput(prices.setupFeePence)} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save prices</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
