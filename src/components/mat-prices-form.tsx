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
              <Field key={m.key} state={s} name={m.key} label={`${m.name} (£ each)`} inputMode="decimal" defaultValue={penceToInput(m.pricePence)} />
            ))}
            <Field state={s} name="lip" label="Front lip engraving, each (£)" inputMode="decimal" defaultValue={penceToInput(prices.positions.lip)} />
            <Field state={s} name="underside" label="Underside engraving, each (£)" inputMode="decimal" defaultValue={penceToInput(prices.positions.underside)} />
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
