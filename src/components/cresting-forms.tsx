'use client';

import type { FormState } from '@/lib/action-utils';
import { CREST_METHODS, CREST_POSITIONS, offeredPositions, type CrestPrices } from '@/lib/cresting';
import { penceToInput } from '@/lib/format';
import { ActionButton, ActionForm, FormMessage, Submit, type BoundAction } from './forms';

/** Price per position per method (per item), plus the one-off setup / digitising fee. */
export function CrestPricesForm({
  action, prices, removeAction,
}: {
  action: BoundAction;
  prices: CrestPrices;
  removeAction: (key: string, removed: boolean) => Promise<FormState>;
}) {
  const deleted = CREST_POSITIONS.filter((p) => prices.removed?.includes(p.key));
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
                  <th />
                </tr>
              </thead>
              <tbody>
                {offeredPositions(prices).map((p) => (
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
                    <td className="num">
                      <ActionButton
                        action={removeAction.bind(null, p.key, true)}
                        className="btn small danger"
                        confirm={`Delete ${p.label}? It won’t be offered in the cresting designer or on your customer design page. You can restore it below.`}
                      >
                        Delete
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {deleted.length ? (
            <details className="section">
              <summary>Deleted positions ({deleted.length})</summary>
              <ul className="attention">
                {deleted.map((p) => (
                  <li key={p.key}>
                    <span>
                      <b>{p.label}</b>
                      <div className="muted">Not offered · prices kept for if you restore it</div>
                    </span>
                    <ActionButton action={removeAction.bind(null, p.key, false)} className="btn small">
                      Restore
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
