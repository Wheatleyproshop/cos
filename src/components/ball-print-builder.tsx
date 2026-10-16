'use client';

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PrintBall } from '@/db/schema';
import type { FormState } from '@/lib/action-utils';
import { INK_COLOURS, LOGO_TYPES, MAX_LOGO_BYTES, PRINT_FONTS, type InkKey, type PrintFontKey } from '@/lib/ball-print';
import { money, penceToInput, parseMoneyToPence } from '@/lib/format';
import { drawBall, renderProof, type BallArtwork, type BallScene } from './ball-render';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { Field, FormMessage } from './forms';

const STEPS = ['Ball', 'Personalise', 'Quantity & send'];

/** Draws a ball scene into a crisp, devicePixelRatio-aware canvas. */
function BallCanvas({ scene, size, label }: { scene: BallScene; size: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const px = Math.round(size * Math.min(window.devicePixelRatio || 1, 2));
    if (c.width !== px) c.width = c.height = px;
    drawBall(c.getContext('2d')!, px, scene);
  }, [scene, size]);
  return <canvas ref={ref} role="img" aria-label={label} style={{ width: '100%', maxWidth: size, aspectRatio: '1 / 1', display: 'block' }} />;
}

export function BallPrintBuilder({
  balls,
  setupFeePence,
  action,
  defaults,
}: {
  balls: PrintBall[];
  setupFeePence: number;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  defaults: PickerDefaults;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [step, setStep] = useState(0);
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [ballId, setBallId] = useState<string | null>(null);
  const [mode, setMode] = useState<'logo' | 'text'>('logo');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  const [logoError, setLogoError] = useState('');
  const [lines, setLines] = useState(['', '', '']);
  const [font, setFont] = useState<PrintFontKey>('classic');
  const [ink, setInk] = useState<InkKey>('navy');
  const [scale, setScale] = useState(0.8);
  const [view, setView] = useState<'logo' | 'brand'>('logo');
  const [guide, setGuide] = useState(true);
  const [dozens, setDozens] = useState(1);
  const [price, setPrice] = useState('');
  const [setup, setSetup] = useState(penceToInput(setupFeePence));
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const ball = balls.find((b) => b.id === ballId) ?? null;
  const brands = [...new Set(balls.map((b) => b.brand))];
  const shown = balls.filter((b) => !brandFilter || b.brand === brandFilter);

  const artwork: BallArtwork =
    mode === 'logo' ? (logoImg ? { type: 'logo', image: logoImg, scale } : null) : { type: 'text', lines, font, ink, scale };
  const hasArtwork = mode === 'logo' ? Boolean(logoImg) : lines.some((l) => l.trim());
  const scene: BallScene = useMemo(
    () => ({ colour: ball?.colour ?? '#ffffff', brand: ball?.brand ?? '', model: ball?.name ?? '', view, artwork, guide, backdrop: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ball, view, logoImg, mode, lines, font, ink, scale, guide],
  );

  const pricePence = parseMoneyToPence(price) ?? 0;
  const setupPence = parseMoneyToPence(setup) ?? 0;
  const total = dozens * pricePence + setupPence;

  const chooseBall = (b: PrintBall) => {
    setBallId(b.id);
    setPrice(penceToInput(b.pricePerDozenPence));
    setDozens((d) => Math.max(d, b.minDozens));
    setView('logo');
  };

  const loadLogo = (file: File | undefined | null) => {
    setLogoError('');
    if (!file) return;
    if (!LOGO_TYPES[file.type]) return setLogoError('Please use a PNG, JPG or WebP image. Ask the customer for a PNG of their logo if you only have a PDF.');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('That image is over 3 MB. Please use a smaller version.');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setLogoFile(file);
      setLogoImg(img);
      setView('logo');
    };
    img.onerror = () => setLogoError('That image could not be read.');
    img.src = url;
  };

  const canNext = step === 0 ? Boolean(ball) : step === 1 ? hasArtwork : true;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ball || !hasArtwork) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget);
    fd.set('intent', submitter?.value ?? 'save');
    setBusy(true);
    try {
      fd.set('proof', await renderProof(scene));
    } finally {
      setBusy(false);
    }
    if (mode === 'logo' && logoFile) fd.set('logo', logoFile);
    startTransition(() => formAction(fd));
  };

  const working = pending || busy;

  return (
    <div className="ballprint">
      <section className="bp-stage" aria-label="Live preview">
        <div className="bp-stage-top">
          <div className="seg" role="tablist" aria-label="Ball side">
            <button type="button" role="tab" aria-selected={view === 'logo'} className={view === 'logo' ? 'on' : ''} onClick={() => setView('logo')}>
              Logo side
            </button>
            <button type="button" role="tab" aria-selected={view === 'brand'} className={view === 'brand' ? 'on' : ''} onClick={() => setView('brand')} disabled={!ball}>
              Brand side
            </button>
          </div>
          <label className="bp-guide">
            <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> Print area
          </label>
        </div>
        <div className="bp-canvas">
          <BallCanvas scene={scene} size={560} label={ball ? `Preview of ${ball.brand} ${ball.name} with personalisation` : 'Golf ball preview'} />
        </div>
        <div className="bp-caption">
          {ball ? (
            <>
              <small>{ball.brand}</small>
              <b>{ball.name}</b>
              <span>{money(pricePence || ball.pricePerDozenPence)} per dozen</span>
            </>
          ) : (
            <span>Choose a ball to begin</span>
          )}
        </div>
      </section>

      <section className="bp-panel">
        <ol className="stepper bp-steps" aria-label="Ball printing steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <button
                type="button"
                onClick={() => setStep(i)}
                disabled={(i >= 1 && !ball) || (i >= 2 && !hasArtwork)}
                aria-current={i === step ? 'step' : undefined}
              >
                <span className="num">{i < step ? '✓' : i + 1}</span>
                <span className="lbl">{s}</span>
              </button>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div aria-live="polite">
            <h2>Choose your ball</h2>
            <p className="muted">Every ball is priced per dozen, including printing.</p>
            {brands.length > 1 ? (
              <div className="pills" style={{ marginTop: 12 }}>
                <button type="button" className={`pill${!brandFilter ? ' selected' : ''}`} onClick={() => setBrandFilter(null)}>
                  All
                </button>
                {brands.map((b) => (
                  <button key={b} type="button" className={`pill${brandFilter === b ? ' selected' : ''}`} onClick={() => setBrandFilter(b)}>
                    {b}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="bp-balls">
              {shown.map((b) => (
                <button key={b.id} type="button" className={`bp-ball${b.id === ballId ? ' selected' : ''}`} aria-pressed={b.id === ballId} onClick={() => chooseBall(b)}>
                  <BallCanvas scene={{ colour: b.colour, brand: b.brand, model: b.name, view: 'brand', artwork: null, backdrop: false }} size={120} label="" />
                  <small>{b.brand}</small>
                  <b>{b.name}</b>
                  <span>{money(b.pricePerDozenPence)}/dz</span>
                </button>
              ))}
            </div>
          </div>
        ) : step === 1 ? (
          <div aria-live="polite">
            <h2>Personalise</h2>
            <p className="muted">Upload the customer’s logo or type a message. The preview updates as you go.</p>
            <div className="seg wide" role="tablist" aria-label="Personalisation type" style={{ marginTop: 14 }}>
              <button type="button" role="tab" aria-selected={mode === 'logo'} className={mode === 'logo' ? 'on' : ''} onClick={() => setMode('logo')}>
                Upload a logo
              </button>
              <button type="button" role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
                Add text
              </button>
            </div>

            {mode === 'logo' ? (
              <>
                <div
                  className={`bp-drop${dragging ? ' over' : ''}${logoFile ? ' has' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    loadLogo(e.dataTransfer.files[0]);
                  }}
                >
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => loadLogo(e.target.files?.[0])} />
                  {logoFile ? (
                    <>
                      <b>{logoFile.name}</b>
                      <span className="muted">{Math.round(logoFile.size / 1024)} KB</span>
                    </>
                  ) : (
                    <>
                      <b>Drop the logo here</b>
                      <span className="muted">PNG, JPG or WebP, up to 3 MB. A transparent PNG prints best.</span>
                    </>
                  )}
                  <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
                    {logoFile ? 'Replace image' : 'Choose image'}
                  </button>
                </div>
                {logoError ? <p className="error" role="alert">{logoError}</p> : null}
              </>
            ) : (
              <>
                <div className="bp-lines">
                  {lines.map((l, i) => (
                    <label key={i} className="field">
                      <span>Line {i + 1}{i === 0 ? '' : ' (optional)'}</span>
                      <input
                        value={l}
                        maxLength={24}
                        placeholder={i === 0 ? 'e.g. Happy Birthday Dad' : ''}
                        onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                    </label>
                  ))}
                </div>
                <h3>Style</h3>
                <div className="bp-fonts">
                  {PRINT_FONTS.map((f) => (
                    <button key={f.key} type="button" className={`bp-font${font === f.key ? ' selected' : ''}`} aria-pressed={font === f.key} onClick={() => setFont(f.key)}>
                      <span style={{ font: f.css.replace('{size}', '20') }}>Aa</span>
                      <small>{f.label}</small>
                    </button>
                  ))}
                </div>
                <h3>Ink colour</h3>
                <div className="bp-inks">
                  {INK_COLOURS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      className={`bp-ink${ink === c.key ? ' selected' : ''}`}
                      style={{ background: c.hex }}
                      aria-pressed={ink === c.key}
                      aria-label={c.label}
                      title={c.label}
                      onClick={() => setInk(c.key)}
                    />
                  ))}
                </div>
              </>
            )}

            <label className="bp-size">
              <span>Size</span>
              <input type="range" min={0.4} max={1} step={0.01} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
            </label>
          </div>
        ) : (
          <form onSubmit={submit} noValidate={false}>
            <h2>Quantity &amp; send</h2>
            <p className="muted">Add the customer, then save as a draft or email the proof for approval.</p>
            <input type="hidden" name="ballId" value={ballId ?? ''} />
            <input type="hidden" name="artworkType" value={mode} />
            <input type="hidden" name="font" value={font} />
            <input type="hidden" name="ink" value={ink} />
            <input type="hidden" name="scale" value={scale} />
            {mode === 'text' ? lines.map((l, i) => <input key={i} type="hidden" name="textLines" value={l} />) : null}
            <FormMessage state={state} />

            <div className="bp-qty">
              <span>Dozens</span>
              <div className="stepperinput">
                <button type="button" aria-label="One dozen fewer" onClick={() => setDozens((d) => Math.max(ball?.minDozens ?? 1, d - 1))}>
                  −
                </button>
                <input
                  name="dozens"
                  inputMode="numeric"
                  value={dozens}
                  onChange={(e) => setDozens(Math.max(1, Math.min(500, Number(e.target.value.replace(/\D/g, '')) || 1)))}
                  aria-label="Number of dozens"
                />
                <button type="button" aria-label="One dozen more" onClick={() => setDozens((d) => Math.min(500, d + 1))}>
                  +
                </button>
              </div>
              <small className="muted">{dozens * 12} balls{ball && ball.minDozens > 1 ? ` · minimum ${ball.minDozens} dozen` : ''}</small>
            </div>

            <div className="fields" style={{ marginTop: 14 }}>
              <label className="field">
                <span>Price per dozen (GBP) *</span>
                <input name="pricePerDozenPence" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
              </label>
              <label className="field">
                <span>Artwork setup fee (GBP)</span>
                <input name="setupFeePence" inputMode="decimal" value={setup} onChange={(e) => setSetup(e.target.value)} />
              </label>
              <CustomerPicker state={state} defaults={defaults} />
              <Field state={state} name="validUntil" label="Proof valid until" type="date" />
              <Field state={state} name="notes" label="Notes for the customer" wide textarea placeholder="e.g. Logo printed in full colour on one side. Delivered in branded sleeves." />
            </div>

            <div className="bp-total">
              <div>
                <span>{dozens} dozen × {money(pricePence)}</span>
                {setupPence ? <span>Artwork setup {money(setupPence)}</span> : null}
              </div>
              <b>{money(total)}</b>
            </div>

            <div className="actions">
              <button className="btn" type="submit" name="intent" value="save" disabled={working || !ball || !hasArtwork}>
                Save as draft
              </button>
              <button className="btn primary" type="submit" name="intent" value="send" disabled={working || !ball || !hasArtwork}>
                {working ? 'Creating proof…' : 'Email proof for approval →'}
              </button>
            </div>
          </form>
        )}

        {step < STEPS.length - 1 ? (
          <div className="actions">
            {step > 0 ? (
              <button type="button" className="btn" onClick={() => setStep(step - 1)}>
                ← Back
              </button>
            ) : null}
            <button type="button" className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next: {STEPS[step + 1]} →
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
