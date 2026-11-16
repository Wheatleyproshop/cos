'use client';

import { useState } from 'react';
import { money } from '@/lib/format';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

type Item = { id: string; product: string; colour: string; pricePence: number; sizes: string[]; image: string | null };

/** The team member's order (public page): a size for each garment they want, optional name, their details, and acceptance. */
export function TeamOrderForm(p: {
  action: BoundAction;
  brand: string;
  items: Item[];
  namePricePence: number;
  nameOffered: boolean;
  namePlacement: string;
  nameMaxLength: number;
  terms: string;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [addName, setAddName] = useState(false);
  const chosen = p.items.filter((i) => picked[i.id]);
  const total = chosen.reduce((n, i) => n + i.pricePence + (addName ? p.namePricePence : 0), 0);
  return (
    <ActionForm action={p.action}>
      {(s) => {
        if (s?.ok && s.message) {
          return (
            <div className="notice ok request-done" role="status">
              <b>Thank you — your order is placed</b>
              <p>{s.message}</p>
              <p>
                <a href="">Place another order</a>
              </p>
            </div>
          );
        }
        const nameOn = addName || s?.values?.addName === 'yes';
        return (
          <>
            <h2 className="request-h">Choose your size for each item you’d like</h2>
            <div className="team-items">
              {p.items.map((it) => {
                const err = s?.fieldErrors?.[`size_${it.id}`];
                const was = s?.values?.[`size_${it.id}`] ?? '';
                return (
                  <div key={it.id} className={`team-item${picked[it.id] || was ? ' on' : ''}${it.image ? '' : ' noimg'}`}>
                    {it.image ? (
                      <div className="team-item-img">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={it.image} alt={`${p.brand} ${it.product}${it.colour ? `, ${it.colour}` : ''}`} />
                      </div>
                    ) : null}
                    <div>
                      <h3>{it.product}</h3>
                      <div className="muted">
                        {p.brand}
                        {it.colour ? ` · ${it.colour}` : ''}
                      </div>
                      <div className="team-item-price">{money(it.pricePence)}</div>
                      <div className="team-sizes" role="radiogroup" aria-label={`${it.product} size`}>
                        <label className="team-size none">
                          <input type="radio" name={`size_${it.id}`} value="" defaultChecked={!was} onChange={() => setPicked({ ...picked, [it.id]: '' })} />
                          <span>None</span>
                        </label>
                        {it.sizes.map((size) => (
                          <label key={size} className="team-size">
                            <input type="radio" name={`size_${it.id}`} value={size} defaultChecked={was === size} onChange={() => setPicked({ ...picked, [it.id]: size })} />
                            <span>{size}</span>
                          </label>
                        ))}
                      </div>
                      {err ? <p className="err">{err}</p> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {s?.fieldErrors?.items ? <p className="err">{s.fieldErrors.items}</p> : null}

            {p.nameOffered ? (
              <>
                <h2 className="request-h">Your name on it?</h2>
                <label className="check team-check">
                  <input type="checkbox" name="addName" value="yes" defaultChecked={s?.values?.addName === 'yes'} onChange={(e) => setAddName(e.target.checked)} />
                  <span>
                    Yes, add my name{p.namePlacement ? ` (${p.namePlacement.toLowerCase()})` : ''}
                    {p.namePricePence ? ` · +${money(p.namePricePence)} per item` : ''}
                  </span>
                </label>
                {nameOn ? (
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
              <span>
                Total
                {chosen.length ? (
                  <ul className="team-lines muted">
                    {chosen.map((i) => (
                      <li key={i.id}>
                        {i.product}, size {picked[i.id]}
                        {addName && p.namePricePence ? ' + name' : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </span>
              <b>{money(total)}</b>
            </div>
            {p.terms ? <p className="muted request-small">{p.terms}</p> : null}
            <label className={`check team-check${s?.fieldErrors?.accept ? ' invalid' : ''}`}>
              <input type="checkbox" name="accept" value="yes" required />
              <span>I accept this order and agree to pay {chosen.length ? money(total) : 'the total shown'}.</span>
            </label>
            {s?.fieldErrors?.accept ? <p className="err">{s.fieldErrors.accept}</p> : null}
            <FormMessage state={s} />
            <div className="actions">
              <Submit pendingText="Placing your order…">{chosen.length ? `Place my order · ${money(total)}` : 'Place my order'}</Submit>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
