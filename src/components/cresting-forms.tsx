'use client';

import { CREST_METHODS, CREST_POSITIONS, type CrestPrices } from '@/lib/cresting';
import { penceToInput } from '@/lib/format';
import { ActionForm, FormMessage, Submit, type BoundAction } from './forms';

/** Price per position per method (per item), plus the one-off setup / digitising fee. */
export function CrestPricesForm({ action, prices }: { action: BoundAction; prices: CrestPrices }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Position</th>
                  {CREST_METHODS.map((m) => (
                    <th key={m.key} className="num">
                      {m.label} (£ each)
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CREST_POSITIONS.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <b>{p.label}</b>
                      <div className="muted">{p.garment === 'cap' ? 'Caps & hats' : 'Clothing'}</div>
                    </td>
                    {CREST_METHODS.map((m) => (
                      <td key={m.key} className="num">
                        <input
                          name={`${p.key}.${m.key}`}
                          inputMode="decimal"
                          defaultValue={penceToInput(prices.positions[p.key][m.key])}
                          aria-label={`${p.label} ${m.label.toLowerCase()} price`}
                          className="cr-price"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="field" style={{ marginTop: 14, maxWidth: 320 }}>
            <span>Setup / digitising fee per job (£)</span>
            <input name="setupFeePence" inputMode="decimal" defaultValue={penceToInput(prices.setupFeePence)} />
          </label>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save prices</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
