'use client';

import { useState } from 'react';
import { money } from '@/lib/format';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

/** The team member's order (public page): size, optional name, their details, and acceptance. */
export function TeamOrderForm(p: {
  action: BoundAction;
  sizes: string[];
  pricePence: number;
  namePricePence: number;
  nameOffered: boolean;
  namePlacement: string;
  nameMaxLength: number;
  terms: string;
}) {
  const [addName, setAddName] = useState(false);
  const total = p.pricePence + (addName ? p.namePricePence : 0);
  return (
    <ActionForm action={p.action}>
      {(s) => {
        if (s?.ok && s.message) {
          return (
            <div className="notice ok request-done" role="status">
              <b>Thank you — your order is placed</b>
              <p>{s.message}</p>
              <p>
                <a href="">Order another one</a>
              </p>
            </div>
          );
        }
        const wanted = s?.values ? s.values.addName === 'yes' : addName;
        return (
          <>
            <div className="team-price">
              <b>{money(p.pricePence)}</b>
              {p.namePricePence ? <span> · add your name for {money(p.namePricePence)}</span> : null}
            </div>

            <h2 className="request-h">Your size *</h2>
            <div className="team-sizes" role="radiogroup" aria-label="Size">
              {p.sizes.map((size) => (
                <label key={size} className="team-size">
                  <input type="radio" name="size" value={size} required defaultChecked={s?.values?.size === size} />
                  <span>{size}</span>
                </label>
              ))}
            </div>
            {s?.fieldErrors?.size ? <p className="err">{s.fieldErrors.size}</p> : null}

            {p.nameOffered ? (
              <>
                <h2 className="request-h">Your name on it?</h2>
                <label className="check team-check">
                  <input type="checkbox" name="addName" value="yes" defaultChecked={wanted} onChange={(e) => setAddName(e.target.checked)} />
                  <span>
                    Yes, add my name{p.namePlacement ? ` (${p.namePlacement.toLowerCase()})` : ''}
                    {p.namePricePence ? ` · +${money(p.namePricePence)}` : ''}
                  </span>
                </label>
                {addName || wanted ? (
                  <div className="fields">
                    <Field
                      state={s}
                      name="printedName"
                      label="Name to print"
                      required
                      wide
                      placeholder="e.g. Sarah"
                      hint={`Exactly as you’d like it to appear, up to ${p.nameMaxLength} characters. Check the spelling.`}
                    />
                  </div>
                ) : null}
              </>
            ) : null}

            <h2 className="request-h">Your details</h2>
            <div className="fields">
              <Field state={s} name="customerName" label="Your name" required autoComplete="name" />
              <Field state={s} name="email" label="Email" type="email" required autoComplete="email" inputMode="email" />
              <Field state={s} name="phone" label="Mobile (optional)" type="tel" autoComplete="tel" inputMode="tel" hint="So we can text you when it’s ready" />
            </div>
            <label className="bp-hp" aria-hidden="true">
              Website <input name="website" tabIndex={-1} autoComplete="off" />
            </label>

            <div className="team-total">
              <span>Total</span>
              <b>{money(total)}</b>
            </div>
            {p.terms ? <p className="muted request-small">{p.terms}</p> : null}
            <label className={`check team-check${s?.fieldErrors?.accept ? ' invalid' : ''}`}>
              <input type="checkbox" name="accept" value="yes" required />
              <span>I accept this order and agree to pay {money(total)}.</span>
            </label>
            {s?.fieldErrors?.accept ? <p className="err">{s.fieldErrors.accept}</p> : null}
            <FormMessage state={s} />
            <div className="actions">
              <Submit pendingText="Placing your order…">Place my order · {money(total)}</Submit>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
