'use client';

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { FormState } from '@/lib/action-utils';
import { LOGO_TYPES, MAX_LOGO_BYTES, PRINT_FONTS, type PrintFontKey } from '@/lib/ball-print';
import { money, parseMoneyToPence, penceToInput } from '@/lib/format';
import { MAT_POSITIONS, OWN_MAT, type MatPile, type MatPositionKey, type MatPrices } from '@/lib/mat-engraving';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { Field, FormMessage } from './forms';
import { drawMat, renderMatProof, type MatDrawEngraving, type MatView } from './mat-render';

const STEPS = ['Mat & engraving', 'Quantity & send'];
const MAX_LOGOS = 2;

type Logo = { file: File; image: HTMLImageElement };
type Place = { on: boolean; kind: 'text' | 'logo'; lines: string[]; font: PrintFontKey; logo: number; scale: number };
const blank = (on: boolean): Place => ({ on, kind: 'text', lines: ['', ''], font: 'modern', logo: 0, scale: 0.8 });

function Stage({ view, engravings, pile }: { view: MatView; engravings: MatDrawEngraving[]; pile: MatPile }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const px = Math.round((c.clientWidth || 560) * Math.min(window.devicePixelRatio || 1, 2));
    if (c.width !== px) c.width = c.height = px;
    drawMat(c.getContext('2d')!, px, view, engravings, { guide: true, pile });
  }, [view, engravings, pile]);
  return (
    <div className="cr-stage">
      <canvas ref={ref} role="img" aria-label={`${view === 'top' ? 'Top' : 'Underside'} of the mat with the engraving`} style={{ cursor: 'default' }} />
    </div>
  );
}

type MatChoice = MatPile | typeof OWN_MAT;

export function MatEngravingBuilder({
  prices, action, defaults, variant = 'staff',
}: {
  prices: MatPrices;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  defaults: PickerDefaults;
  variant?: 'staff' | 'public';
}) {
  const isPublic = variant === 'public';
  const [state, formAction, pending] = useActionState(action, null);
  const [step, setStep] = useState(0);
  const [view, setView] = useState<MatView>('top');
  const [places, setPlaces] = useState<Record<MatPositionKey, Place>>({ lip: blank(true), underside: blank(false) });
  const [logos, setLogos] = useState<Logo[]>([]);
  const [logoError, setLogoError] = useState('');
  const [mat, setMat] = useState<MatChoice>('short');
  const option = prices.mats.find((m) => m.key === mat);
  const matName = option?.name ?? 'Customer’s own mat';
  const [matPrice, setMatPrice] = useState(penceToInput(prices.mats[0]?.pricePence ?? 0));
  const chooseMat = (m: MatChoice) => {
    setMat(m);
    setMatPrice(penceToInput(prices.mats.find((o) => o.key === m)?.pricePence ?? 0));
  };
  const [qty, setQty] = useState('1');
  const [setup, setSetup] = useState(penceToInput(prices.setupFeePence));
  const [busy, setBusy] = useState(false);

  const update = (k: MatPositionKey, patch: Partial<Place>) => setPlaces((p) => ({ ...p, [k]: { ...p[k], ...patch } }));
  const draws: MatDrawEngraving[] = useMemo(
    () =>
      MAT_POSITIONS.filter((p) => places[p.key].on).map((p) => {
        const pl = places[p.key];
        return {
          position: p.key,
          scale: pl.scale,
          art: pl.kind === 'logo' ? (logos[pl.logo] ? { type: 'logo', image: logos[pl.logo].image } : null) : { type: 'text', lines: pl.lines, font: pl.font },
        };
      }),
    [places, logos],
  );
  const active = MAT_POSITIONS.filter((p) => places[p.key].on);
  const hasArt = active.length > 0 && active.every((p) => (places[p.key].kind === 'logo' ? Boolean(logos[places[p.key].logo]) : places[p.key].lines.some((l) => l.trim())));
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  const engravingEach = active.reduce((t, p) => t + prices.positions[p.key], 0);
  // Customers always see the shop's prices; staff can adjust them on the job.
  const matPence = isPublic ? (option?.pricePence ?? 0) : mat === OWN_MAT ? 0 : (parseMoneyToPence(matPrice || '0') ?? 0);
  const setupPence = isPublic ? prices.setupFeePence : (parseMoneyToPence(setup || '0') ?? 0);
  const total = n * (matPence + engravingEach) + setupPence;

  const addLogo = (file: File | undefined, forKey?: MatPositionKey) => {
    setLogoError('');
    if (!file) return;
    if (!LOGO_TYPES[file.type]) return setLogoError('Please use a PNG, JPG or WebP logo. A black-on-white or transparent PNG engraves best.');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('That logo is over 3 MB. Please use a smaller version.');
    if (logos.length >= MAX_LOGOS) return setLogoError(`Up to ${MAX_LOGOS} logos per job.`);
    const index = logos.length;
    const img = new Image();
    img.onload = () => {
      setLogos((l) => [...l, { file, image: img }]);
      if (forKey) update(forKey, { kind: 'logo', logo: index });
    };
    img.onerror = () => setLogoError('That logo could not be read.');
    img.src = URL.createObjectURL(file);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!hasArt) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget);
    fd.set('intent', submitter?.value ?? 'save');
    fd.set('mat', mat);
    setBusy(true);
    try {
      fd.set('proof', await renderMatProof(draws, mat === 'long' ? 'long' : 'short'));
    } finally {
      setBusy(false);
    }
    logos.forEach((l, i) => fd.set(`logo${i}`, l.file));
    fd.set(
      'engravings',
      JSON.stringify(
        active.map((p) => {
          const pl = places[p.key];
          return {
            position: p.key,
            scale: +pl.scale.toFixed(3),
            artwork: pl.kind === 'logo' ? { type: 'logo', logo: pl.logo } : { type: 'text', lines: pl.lines, font: pl.font },
          };
        }),
      ),
    );
    startTransition(() => formAction(fd));
  };
  const working = pending || busy;

  return (
    <div className="ballprint">
      <section className="bp-stage" aria-label="Live preview">
        <div className="bp-stage-top">
          <div className="seg" role="tablist" aria-label="Mat side">
            <button type="button" role="tab" aria-selected={view === 'top'} className={view === 'top' ? 'on' : ''} onClick={() => setView('top')}>
              Top
            </button>
            <button type="button" role="tab" aria-selected={view === 'underside'} className={view === 'underside' ? 'on' : ''} onClick={() => setView('underside')}>
              Underside
            </button>
          </div>
          <span className="muted">Laser engraved on an xTool F2</span>
        </div>
        <div className="bp-canvas">
          <Stage view={view} engravings={draws} pile={mat === 'long' ? 'long' : 'short'} />
        </div>
        <div className="bp-caption">
          <b>{matName}</b>
          <span>{active.length ? active.map((p) => p.label).join(' + ') : 'Choose where to engrave'}</span>
        </div>
      </section>

      <section className="bp-panel">
        <ol className="stepper bp-steps" aria-label="Mat engraving steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <button type="button" onClick={() => setStep(i)} disabled={i >= 1 && !hasArt} aria-current={i === step ? 'step' : undefined}>
                <span className="num">{i < step ? '✓' : i + 1}</span>
                <span className="lbl">{s}</span>
              </button>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div>
            <h2>The mat</h2>
            <div className="seg wide" role="radiogroup" aria-label="Mat" style={{ marginTop: 8 }}>
              {prices.mats.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={mat === m.key} className={mat === m.key ? 'on' : ''} onClick={() => chooseMat(m.key)}>
                  {m.key === 'short' ? 'Short pile' : 'Long pile'}
                  {m.pricePence ? ` · ${money(m.pricePence)}` : ''}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={mat === OWN_MAT} className={mat === OWN_MAT ? 'on' : ''} onClick={() => chooseMat(OWN_MAT)}>
                {isPublic ? 'I have my own mat' : 'Customer’s own mat'}
              </button>
            </div>
            <h2 style={{ marginTop: 18 }}>What to engrave, and where</h2>
            <p className="muted">A name, initials or a logo, on the front lip (seen from the top) and/or underneath.</p>
            <div className="cr-logos">
              {logos.map((l, i) => (
                <span key={i} className="cr-logo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.image.src} alt="" />
                  <small>Logo {i + 1}</small>
                </span>
              ))}
              {logos.length < MAX_LOGOS ? (
                <label className="btn small">
                  ＋ Upload a logo
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => addLogo(e.target.files?.[0])} />
                </label>
              ) : null}
            </div>
            {logoError ? <p className="error" role="alert">{logoError}</p> : null}
            <div className="cr-list">
              {MAT_POSITIONS.map((p) => {
                const pl = places[p.key];
                return (
                  <div key={p.key} className={`cr-item${pl.on ? ' on' : ''}`} onClick={() => pl.on && setView(p.key === 'lip' ? 'top' : 'underside')}>
                    <label className="cr-item-head check" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={pl.on}
                        onChange={(e) => {
                          update(p.key, { on: e.target.checked });
                          if (e.target.checked) setView(p.key === 'lip' ? 'top' : 'underside');
                        }}
                      />
                      <b>{p.label}</b>
                      <span className="muted">{money(prices.positions[p.key])} each</span>
                    </label>
                    <div className="muted" style={{ fontSize: 12.5 }}>{p.hint}</div>
                    {pl.on ? (
                      <div className="cr-item-body">
                        <div className="seg" role="group" aria-label="Artwork">
                          <button type="button" className={pl.kind === 'text' ? 'on' : ''} aria-pressed={pl.kind === 'text'} onClick={() => update(p.key, { kind: 'text' })}>
                            Name / text
                          </button>
                          <button type="button" className={pl.kind === 'logo' ? 'on' : ''} aria-pressed={pl.kind === 'logo'} onClick={() => update(p.key, { kind: 'logo' })}>
                            Logo
                          </button>
                        </div>
                        {pl.kind === 'text' ? (
                          <>
                            {pl.lines.map((l, i) => (
                              <input
                                key={i}
                                value={l}
                                maxLength={28}
                                aria-label={`${p.label} line ${i + 1}`}
                                placeholder={i === 0 ? 'e.g. AARON HODKIN' : 'Line 2 (optional), e.g. Wheatley GC'}
                                onChange={(e) => update(p.key, { lines: pl.lines.map((x, j) => (j === i ? e.target.value : x)) })}
                              />
                            ))}
                            <select value={pl.font} aria-label="Lettering" onChange={(e) => update(p.key, { font: e.target.value as PrintFontKey })}>
                              {PRINT_FONTS.map((f) => (
                                <option key={f.key} value={f.key}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : logos.length ? (
                          <div className="cr-logopick">
                            {logos.map((l, i) => (
                              <button key={i} type="button" className={pl.logo === i ? 'on' : ''} aria-pressed={pl.logo === i} onClick={() => update(p.key, { logo: i })}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={l.image.src} alt={`Logo ${i + 1}`} />
                              </button>
                            ))}
                          </div>
                        ) : (
                          <label className="btn small">
                            ＋ Upload the logo
                            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => addLogo(e.target.files?.[0], p.key)} />
                          </label>
                        )}
                        <label className="bp-size">
                          <span>Size</span>
                          <input type="range" min={0.25} max={1} step={0.01} value={pl.scale} onChange={(e) => update(p.key, { scale: Number(e.target.value) })} />
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : isPublic && state?.ok ? (
          <div className="bp-thanks" role="status">
            <span className="bp-thanks-tick" aria-hidden="true">✓</span>
            <h2>Design sent</h2>
            <p>{state.message}</p>
          </div>
        ) : isPublic ? (
          <form onSubmit={submit}>
            <h2>Quantity &amp; your details</h2>
            <p className="muted">How many mats, and how we can reach you. We’ll check the design and confirm the price before anything is engraved.</p>
            <FormMessage state={state} />
            <div className="fields" style={{ marginTop: 12 }}>
              <label className="field">
                <span>Quantity</span>
                <input name="quantity" type="number" min={1} max={200} value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>
              <Field state={state} name="customerName" label="Your name" required autoComplete="name" />
              <Field state={state} name="email" label="Email" type="email" required autoComplete="email" />
              <Field state={state} name="phone" label="Mobile" type="tel" autoComplete="tel" />
              <Field state={state} name="notes" label="Anything we should know?" wide textarea placeholder="e.g. A Christmas present, needed by 20 December." />
            </div>
            <label className="bp-hp" aria-hidden="true">
              Website <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
            <div className="bp-total">
              <div>
                <span>
                  {n} mat{n === 1 ? '' : 's'} × {money(matPence + engravingEach)}
                  {mat === OWN_MAT ? ' (engraving only)' : matPence ? ` (mat ${money(matPence)} + engraving ${money(engravingEach)})` : ' (engraving: we’ll confirm the mat price)'}
                </span>
                {setupPence ? <span>Setup {money(setupPence)}</span> : null}
              </div>
              <b>{money(total)}</b>
            </div>
            <div className="actions">
              <button className="btn primary" type="submit" disabled={working || !hasArt}>
                {working ? 'Sending…' : 'Send my design for approval →'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit}>
            <h2>Quantity &amp; send</h2>
            <p className="muted">How many mats, the customer, then save or email the proof for approval.</p>
            <FormMessage state={state} />
            <div className="fields" style={{ marginTop: 12 }}>
              {mat === OWN_MAT ? (
                <input type="hidden" name="matPricePence" value="0" />
              ) : (
                <label className="field">
                  <span>Mat price each (GBP)</span>
                  <input name="matPricePence" inputMode="decimal" value={matPrice} onChange={(e) => setMatPrice(e.target.value)} />
                </label>
              )}
              <label className="field">
                <span>Quantity</span>
                <input name="quantity" type="number" min={1} max={200} value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>
              <label className="field">
                <span>Setup fee (GBP)</span>
                <input name="setupFeePence" inputMode="decimal" value={setup} onChange={(e) => setSetup(e.target.value)} />
              </label>
              <CustomerPicker state={state} defaults={defaults} />
              <Field state={state} name="validUntil" label="Proof valid until" type="date" />
              <Field state={state} name="notes" label="Notes for the customer" wide textarea placeholder="e.g. Engraved name on the lip, ready about 3 days after approval." />
            </div>
            <div className="bp-total">
              <div>
                <span>
                  {n} mat{n === 1 ? '' : 's'} × {money(matPence + engravingEach)}
                  {matPence ? ` (mat ${money(matPence)} + engraving ${money(engravingEach)})` : ' (engraving only)'}
                </span>
                {setupPence ? <span>Setup {money(setupPence)}</span> : null}
              </div>
              <b>{money(total)}</b>
            </div>
            <div className="actions">
              <button className="btn" type="submit" name="intent" value="save" disabled={working || !hasArt}>
                Save as draft
              </button>
              <button className="btn primary" type="submit" name="intent" value="send" disabled={working || !hasArt}>
                {working ? 'Creating proof…' : 'Email proof for approval →'}
              </button>
            </div>
          </form>
        )}

        {step < STEPS.length - 1 && !(isPublic && state?.ok) ? (
          <div className="actions">
            <button type="button" className="btn primary" disabled={!hasArt} onClick={() => setStep(step + 1)}>
              Next: {STEPS[step + 1]} →
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
