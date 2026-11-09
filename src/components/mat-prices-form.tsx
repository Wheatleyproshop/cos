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
            <Field state={s} name="matName" label="Mat" required defaultValue={prices.matName} />
            <Field state={s} name="matPricePence" label="Mat price each (£)" inputMode="decimal" defaultValue={penceToInput(prices.matPricePence)} hint="Leave at 0.00 to enter it on each job." />
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
