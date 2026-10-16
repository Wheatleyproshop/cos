'use client';

import { useActionState, useMemo, useState } from 'react';
import type { Brand, Component, ProductModel } from '@/db/schema';
import type { FormState } from '@/lib/action-utils';
import { CLUB_CATEGORIES, validComponentIds } from '@/lib/fitting-rules';
import { money } from '@/lib/format';
import { ClubIcon, PartIcon } from './club-icon';
import { Field, FormMessage } from './forms';

type Category = { id: string; key: string; label: string };
type Rule = { modelId: string; componentId: string; rule: 'allowed' | 'excluded' | 'default'; upchargeOverridePence: number | null };

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
  defaults: { customerName?: string; email?: string; phone?: string };
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
  const [state, formAction, pending] = useActionState(action, null);

  const brand = catalog.brands.find((b) => b.id === brandId) ?? null;
  const model = catalog.models.find((m) => m.id === modelId) ?? null;
  const heads = catalog.models.filter((m) => (!brandId || m.brandId === brandId) && m.category === club);
  const clubsAvailable = new Set(catalog.models.filter((m) => !brandId || m.brandId === brandId).map((m) => m.category));

  const upcharge = (c: Component) =>
    catalog.rules.find((r) => model && r.modelId === model.id && r.componentId === c.id)?.upchargeOverridePence ?? c.upchargePence;

  const lines = useMemo(() => {
    const out: { label: string; name: string; price: number; kind: string }[] = [];
    if (model) out.push({ label: 'Head', name: `${brand?.name ?? ''} ${model.name}`.trim(), price: model.basePricePence, kind: model.category });
    for (const cat of catalog.categories) {
      const c = catalog.components.find((x) => x.id === picks[cat.id]);
      if (c) out.push({ label: cat.label, name: c.name, price: upcharge(c), kind: cat.key });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, brand, picks, catalog]);
  const total = lines.reduce((s, l) => s + l.price, 0);

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
    if (i <= 1 || modelId) setStep(i);
  };
  const catForStep = step >= 2 && step < steps.length - 1 ? cats[step - 2] : null;

  return (
    <div className="fitting">
      <ol className="stepper" aria-label="Fitting steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <button type="button" onClick={() => go(i)} disabled={i > 1 && !modelId} aria-current={i === step ? 'step' : undefined}>
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
                      <span className="muted">{upcharge(c) > 0 ? `+${money(upcharge(c))}` : upcharge(c) < 0 ? `−${money(-upcharge(c))}` : 'No upcharge'}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <form action={formAction}>
              <h2>{steps.length}. Summary</h2>
              <p className="muted">Add the customer and any build details, then save or send for approval.</p>
              <input type="hidden" name="modelId" value={modelId ?? ''} />
              {Object.values(picks)
                .filter(Boolean)
                .map((id) => (
                  <input key={id} type="hidden" name="componentIds" value={id!} />
                ))}
              <FormMessage state={state} />
              <div className="fields" style={{ marginTop: 14 }}>
                <Field state={state} name="customerName" label="Customer name" required defaultValue={defaults.customerName} />
                <Field state={state} name="email" label="Email address" type="email" required defaultValue={defaults.email} />
                <Field state={state} name="phone" label="Phone" type="tel" defaultValue={defaults.phone} />
                <Field state={state} name="validUntil" label="Quote valid until" type="date" />
                <Field
                  state={state}
                  name="buildNotes"
                  label="Build details"
                  wide
                  textarea
                  placeholder="Loft, flex, length, lie, grip size, wraps, set makeup…"
                />
              </div>
              <div className="actions">
                <button className="btn" type="submit" name="intent" value="save" disabled={pending || !modelId}>
                  Save fitting
                </button>
                <button className="btn primary" type="submit" name="intent" value="send" disabled={pending || !modelId}>
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

        <section className="buildsummary" aria-label="Live build summary">
          <h3>Live build summary</h3>
          {lines.length ? (
            <ul>
              {lines.map((l) => (
                <li key={l.label}>
                  <span>
                    <small>{l.label}</small>
                    {l.name}
                  </span>
                  <b>{money(l.price)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Choose a brand and head to start the build.</p>
          )}
          <div className="total">
            <span>Total (RRP)</span>
            <b>{money(total)}</b>
          </div>
        </section>
      </div>
    </div>
  );
}
