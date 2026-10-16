'use client';

import { useActionState, useMemo, useState } from 'react';
import type { Brand, Component, ProductModel } from '@/db/schema';
import type { FormState } from '@/lib/action-utils';
import { clubsInBuild, CLUB_CATEGORIES, componentPrice, isPerClub, priceBuild, validComponentIds } from '@/lib/fitting-rules';
import { money } from '@/lib/format';
import { ClubIcon, PartIcon } from './club-icon';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { Field, FormMessage } from './forms';
import { BuildTable } from './spec-view';

// Sorts 8° before 10°, and 4-PW before 5-PW.
const NATURAL = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });

type Category = { id: string; key: string; label: string };
type Rule = { modelId: string; componentId: string; rule: 'allowed' | 'excluded' | 'default'; upchargeOverridePence: number | null };

/** A club waiting in the quote: its head, chosen options and notes. */
type Draft = { modelId: string; picks: Record<string, string | null>; notes: string };

export type FittingCatalog = {
  brands: Brand[];
  models: ProductModel[];
  categories: Category[];
  components: Component[];
  rules: Rule[];
};

export function FittingBuilder({
  catalog,
  action,
  defaults,
}: {
  catalog: FittingCatalog;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  defaults: PickerDefaults;
}) {
  const [step, setStep] = useState(0);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [club, setClub] = useState<string>('driver');
  const [modelId, setModelId] = useState<string | null>(null);
  const chosenModel = catalog.models.find((m) => m.id === modelId) ?? null;
  // Only show steps that have something to choose for this head (e.g. no shaft step for a putter with none listed).
  const cats = chosenModel ? catalog.categories.filter((c) => validComponentIds(catalog, chosenModel, c.id).size > 0) : catalog.categories;
  const steps = ['Brand', 'Head', ...cats.map((c) => c.label), 'Summary'];
  const [picks, setPicks] = useState<Record<string, string | null>>({});
  const [notes, setNotes] = useState('');
  const [basket, setBasket] = useState<Draft[]>([]);
  const [state, formAction, pending] = useActionState(action, null);

  const brand = catalog.brands.find((b) => b.id === brandId) ?? null;
  const model = catalog.models.find((m) => m.id === modelId) ?? null;
  const heads = catalog.models.filter((m) => (!brandId || m.brandId === brandId) && m.category === club);
  const clubsAvailable = new Set(catalog.models.filter((m) => !brandId || m.brandId === brandId).map((m) => m.category));

  const chosenComponents = Object.values(picks)
    .map((id) => catalog.components.find((x) => x.id === id))
    .filter((c): c is Component => Boolean(c));
  const clubs = model ? clubsInBuild(model, chosenComponents) : 1;
  const upcharge = (c: Component) => (model ? componentPrice(catalog, model, c, chosenComponents) : c.upchargePence);
  const priceLabel = (c: Component) => {
    const p = upcharge(c);
    const each = isPerClub(c) && clubs > 1 ? ` (${money(p / clubs)} × ${clubs} clubs)` : isPerClub(c) ? ' per club' : '';
    return p > 0 ? `+${money(p)}${each}` : p < 0 ? `−${money(-p)}` : 'No upcharge';
  };

  const buildOf = (d: Draft) => {
    const m = catalog.models.find((x) => x.id === d.modelId);
    return m ? priceBuild(catalog, m, Object.values(d.picks).filter((id): id is string => Boolean(id)), d.notes) : null;
  };
  const current = useMemo(
    () => (modelId ? buildOf({ modelId, picks, notes }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelId, picks, notes, catalog],
  );
  const basketBuilds = basket.map(buildOf);
  const allDrafts = [...basket, ...(modelId ? [{ modelId, picks, notes }] : [])];
  const total = [...basketBuilds, current].reduce((s, b) => s + (b?.totalPence ?? 0), 0);

  /** Puts the current club in the quote and starts the next one (same brand). */
  const addAnotherClub = () => {
    if (modelId) setBasket((b) => [...b, { modelId, picks, notes }]);
    setModelId(null);
    setPicks({});
    setNotes('');
    setStep(brandId ? 1 : 0);
  };
  const editClub = (i: number) => {
    const d = basket[i];
    setBasket((b) => [...b.filter((_, j) => j !== i), ...(modelId ? [{ modelId, picks, notes }] : [])]);
    const m = catalog.models.find((x) => x.id === d.modelId);
    if (m) {
      setBrandId(m.brandId);
      setClub(m.category);
    }
    setModelId(d.modelId);
    setPicks(d.picks);
    setNotes(d.notes);
    setStep(1);
  };
  const removeClub = (i: number) => setBasket((b) => b.filter((_, j) => j !== i));

  const chooseModel = (m: ProductModel) => {
    setModelId(m.id);
    if (!brandId) setBrandId(m.brandId);
    // Drop selections that aren't valid for the new head (e.g. wood shaft on irons).
    setPicks((p) =>
      Object.fromEntries(Object.entries(p).map(([cat, id]) => [cat, id && validComponentIds(catalog, m, cat).has(id) ? id : null])),
    );
  };

  const canNext = step === 0 ? Boolean(brandId) : step === 1 ? Boolean(modelId) : true;
  const go = (i: number) => {
    if (i <= 1 || modelId || (basket.length && i === steps.length - 1)) setStep(i);
  };
  const catForStep = step >= 2 && step < steps.length - 1 ? cats[step - 2] : null;

  return (
    <div className="fitting">
      <ol className="stepper" aria-label="Fitting steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <button
              type="button"
              onClick={() => go(i)}
              disabled={i > 1 && !modelId && !(basket.length && i === steps.length - 1)}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="num">{i < step ? '✓' : i + 1}</span>
              <span className="lbl">{s}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="fitting-body">
        <section className="fitting-main" aria-live="polite">
          {step === 0 ? (
            <>
              <h2>1. Select manufacturer</h2>
              <p className="muted">Choose the brand for this fitting</p>
              <div className="cardgrid">
                {catalog.brands.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`pick${b.id === brandId ? ' selected' : ''}`}
                    aria-pressed={b.id === brandId}
                    onClick={() => {
                      setBrandId(b.id);
                      if (model && model.brandId !== b.id) setModelId(null);
                    }}
                  >
                    <span className="wordmark">{b.name}</span>
                    <ClubIcon kind="driver" size={96} />
                    <b>{b.name}</b>
                    <span className="muted">{b.tagline}</span>
                  </button>
                ))}
              </div>
              <h3>Popular categories</h3>
              <div className="cardgrid six">
                {CLUB_CATEGORIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`pick small${club === c.key ? ' selected' : ''}`}
                    aria-pressed={club === c.key}
                    onClick={() => setClub(c.key)}
                  >
                    <ClubIcon kind={c.key} size={44} />
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
            </>
          ) : step === 1 ? (
            <>
              <h2>2. Select head</h2>
              <p className="muted">
                {brand ? brand.name : 'All brands'} · {CLUB_CATEGORIES.find((c) => c.key === club)?.label}
              </p>
              <div className="pills" style={{ marginTop: 12 }}>
                {CLUB_CATEGORIES.filter((c) => clubsAvailable.has(c.key)).map((c) => (
                  <button key={c.key} type="button" className={`pill${club === c.key ? ' selected' : ''}`} onClick={() => setClub(c.key)}>
                    {c.label}
                  </button>
                ))}
              </div>
              {heads.length ? (
                <div className="cardgrid">
                  {heads.map((m) => (
                    <button key={m.id} type="button" className={`pick${m.id === modelId ? ' selected' : ''}`} aria-pressed={m.id === modelId} onClick={() => chooseModel(m)}>
                      <ClubIcon kind={m.category} size={84} />
                      <b>{m.name}</b>
                      <span className="muted">{money(m.basePricePence)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty">No {CLUB_CATEGORIES.find((c) => c.key === club)?.label.toLowerCase()} for this brand in your catalogue yet.</p>
              )}
            </>
          ) : catForStep && model ? (
            <>
              <h2>
                {step + 1}. {catForStep.label} selection
              </h2>
              <p className="muted">Optional — choose an option or keep it stock.</p>
              <div className="cardgrid">
                {catalog.components
                  .filter((c) => validComponentIds(catalog, model, catForStep.id).has(c.id))
                  .sort((a, b) => upcharge(a) - upcharge(b) || NATURAL.compare(a.name, b.name))
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`pick${picks[catForStep.id] === c.id ? ' selected' : ''}`}
                      aria-pressed={picks[catForStep.id] === c.id}
                      onClick={() => setPicks((p) => ({ ...p, [catForStep.id]: p[catForStep.id] === c.id ? null : c.id }))}
                    >
                      <PartIcon kind={catForStep.key} size={64} />
                      <b>{c.name}</b>
                      <span className="muted">{priceLabel(c)}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <form action={formAction}>
              <h2>{steps.length}. Quote summary</h2>
              <p className="muted">Check each club, add another for a full bag, then add the customer and save or send.</p>
              <input type="hidden" name="builds" value={JSON.stringify(allDrafts.map((d) => ({ modelId: d.modelId, componentIds: Object.values(d.picks).filter(Boolean), notes: d.notes })))} />
              <FormMessage state={state} />

              <div className="specview" style={{ marginTop: 14 }}>
                {basketBuilds.map((b, i) =>
                  b ? (
                    <BuildTable
                      key={i}
                      build={b}
                      index={i}
                      actions={
                        <>
                          <button type="button" className="btn small" onClick={() => editClub(i)}>
                            Edit
                          </button>
                          <button type="button" className="btn small" onClick={() => removeClub(i)}>
                            Remove
                          </button>
                        </>
                      }
                    />
                  ) : null,
                )}
                {current ? (
                  <BuildTable
                    build={current}
                    index={basket.length ? basket.length : undefined}
                    actions={
                      <label className="field wide" style={{ width: '100%' }}>
                        <span>Notes for this club</span>
                        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. +0.5in length, 2° upright, midsize grips" maxLength={1000} />
                      </label>
                    }
                  />
                ) : null}
                <button type="button" className="btn addclub" onClick={addAnotherClub}>
                  + {current ? 'Add another club to this quote' : 'Choose a club'}
                </button>
              </div>

              <div className="fields" style={{ marginTop: 18 }}>
                <CustomerPicker state={state} defaults={defaults} />
                <Field state={state} name="validUntil" label="Quote valid until" type="date" />
                <Field
                  state={state}
                  name="buildNotes"
                  label="Fitting notes (whole quote)"
                  wide
                  textarea
                  placeholder="Lie angles, lengths, swing weight, grip size, wraps, delivery…"
                />
              </div>
              <div className="spectotal">
                <span>
                  Total{allDrafts.length > 1 ? ` for ${allDrafts.length} clubs` : ''}
                </span>
                <b>{money(total)}</b>
              </div>
              <div className="actions">
                <button className="btn" type="submit" name="intent" value="save" disabled={pending || !allDrafts.length}>
                  Save fitting
                </button>
                <button className="btn primary" type="submit" name="intent" value="send" disabled={pending || !allDrafts.length}>
                  {pending ? 'Creating…' : 'Create quote & email customer →'}
                </button>
              </div>
              <p className="muted">“Save fitting” keeps it as a draft quote you can send later.</p>
            </form>
          )}

          {step < steps.length - 1 ? (
            <div className="actions">
              {step > 0 ? (
                <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                  ← Back
                </button>
              ) : null}
              <button type="button" className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Next: {steps[step + 1]} →
              </button>
            </div>
          ) : null}
        </section>

        <section className="buildsummary" aria-label="Quote summary">
          <h3>{allDrafts.length > 1 ? `Quote · ${allDrafts.length} clubs` : 'Live build summary'}</h3>
          {basketBuilds.length ? (
            <ul className="basket">
              {basketBuilds.map((b, i) =>
                b ? (
                  <li key={i}>
                    <span>
                      <small>Club {i + 1}</small>
                      {b.title}
                    </span>
                    <b>{money(b.totalPence)}</b>
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}
          {current ? (
            <>
              {basket.length ? <h4>Club {basket.length + 1} (building)</h4> : null}
              <ul>
                {current.lines.map((l, i) => (
                  <li key={i}>
                    <span>
                      <small>{l.label}</small>
                      {l.value}
                      {l.detail ? <small>{l.detail}</small> : null}
                    </span>
                    <b>{money(l.pricePence)}</b>
                  </li>
                ))}
              </ul>
              {step < steps.length - 1 ? (
                <button type="button" className="btn small" style={{ marginTop: 10, width: '100%' }} onClick={addAnotherClub}>
                  + Add to quote &amp; build another club
                </button>
              ) : null}
            </>
          ) : basket.length ? (
            <p className="muted">Choose the next head, or go to the summary to send the quote.</p>
          ) : (
            <p className="muted">Choose a brand and head to start the build.</p>
          )}
          <div className="total">
            <span>Total (RRP)</span>
            <b>{money(total)}</b>
          </div>
          {basket.length && !current ? (
            <button type="button" className="btn primary small" style={{ marginTop: 10, width: '100%' }} onClick={() => setStep(steps.length - 1)}>
              Go to quote summary →
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
