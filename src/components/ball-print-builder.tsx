'use client';

import { startTransition, useActionState, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { FormState } from '@/lib/action-utils';
import { INK_COLOURS, LOGO_TYPES, MAX_LOGO_BYTES, PRINT_FONTS, type InkKey, type PrintFontKey } from '@/lib/ball-print';
import { money, penceToInput, parseMoneyToPence } from '@/lib/format';
import {
  artworkDecal, BRAND_SIDE, IDENTITY, photoDecal, qAxisAngle, qMul, qNormalize, qSlerp, renderBall, renderProof, sidestampDecal,
  type BallArtwork, type BallLook, type Quat,
} from './ball-render';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { Field, FormMessage } from './forms';

const STEPS = ['Ball', 'Personalise', 'Quantity & send'];

export type BuilderBall = {
  id: string; brand: string; name: string; colour: string; pricePerDozenPence: number; minDozens: number; photoUrl: string | null;
};

type Img = HTMLImageElement;

function loadImage(url: string): Promise<Img> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/**
 * The interactive 3D ball: drag (mouse, finger or arrow keys) to spin it in any direction,
 * with a little momentum. `target` animates it to the logo or brand side.
 */
function BallStage({ look, target, guide, label }: { look: BallLook; target: { q: Quat; n: number }; guide: boolean; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const q = useRef<Quat>(target.q);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);
  const vel = useRef({ x: 0, y: 0 });
  const frame = useRef(0);
  const [hint, setHint] = useState(true);

  const draw = useCallback(
    (quality: number) => {
      const c = ref.current;
      if (!c) return;
      const px = Math.round(c.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) || 560;
      if (c.width !== px) c.width = c.height = px;
      renderBall(c.getContext('2d')!, px, look, q.current, { guide, quality });
    },
    [look, guide],
  );

  // Redraw at full quality whenever the design changes.
  useEffect(() => {
    if (!drag.current) draw(1);
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw(1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  // Animate to the requested side.
  useEffect(() => {
    cancelAnimationFrame(frame.current);
    const from = q.current;
    const start = performance.now();
    const dur = 750;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      q.current = qSlerp(from, target.q, e);
      draw(t < 1 ? 0.5 : 1);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const rotateBy = (dx: number, dy: number) => {
    const c = ref.current!;
    const R = c.clientWidth * 0.355;
    const angle = Math.hypot(dx, dy) / R;
    if (angle > 0) q.current = qNormalize(qMul(qAxisAngle(dy, dx, 0, angle), q.current));
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    cancelAnimationFrame(frame.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    vel.current = { x: 0, y: 0 };
    setHint(false);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const now = performance.now();
    const dt = Math.max(1, now - d.t);
    vel.current = { x: (dx / dt) * 16, y: (dy / dt) * 16 };
    drag.current = { x: e.clientX, y: e.clientY, t: now };
    rotateBy(dx, dy);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => draw(0.45));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    // Momentum, then a crisp full-quality frame.
    const spin = () => {
      vel.current = { x: vel.current.x * 0.92, y: vel.current.y * 0.92 };
      if (Math.hypot(vel.current.x, vel.current.y) < 0.3) return draw(1);
      rotateBy(vel.current.x, vel.current.y);
      draw(0.45);
      frame.current = requestAnimationFrame(spin);
    };
    frame.current = requestAnimationFrame(spin);
  };
  const key = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = 18;
    const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!m[e.key]) return;
    e.preventDefault();
    rotateBy(...m[e.key]);
    draw(1);
    setHint(false);
  };

  return (
    <div className="bp-3d">
      <canvas
        ref={ref}
        role="img"
        aria-label={`${label}. Drag or use the arrow keys to rotate.`}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      />
      {hint ? <span className="bp-hint" aria-hidden="true">⟲ Drag to spin the ball</span> : null}
    </div>
  );
}

/** Small static render for balls without a product photo. */
function BallThumb({ ball }: { ball: BuilderBall }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ball.photoUrl) return;
    const c = ref.current;
    if (!c) return;
    c.width = c.height = 200;
    const look: BallLook = { colour: ball.colour, front: null, back: sidestampDecal(ball.brand, ball.name, ball.colour) };
    renderBall(c.getContext('2d')!, 200, look, BRAND_SIDE);
  }, [ball]);
  return ball.photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={ball.photoUrl} alt="" className="bp-thumb" />
  ) : (
    <canvas ref={ref} className="bp-thumb" aria-hidden="true" />
  );
}

export function BallPrintBuilder({
  balls,
  setupFeePence,
  action,
  defaults,
}: {
  balls: BuilderBall[];
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
  const [view, setViewState] = useState<{ side: 'logo' | 'brand'; q: Quat; n: number }>({ side: 'brand', q: BRAND_SIDE, n: 0 });
  const setView = (side: 'logo' | 'brand') => setViewState((v) => ({ side, q: side === 'logo' ? IDENTITY : BRAND_SIDE, n: v.n + 1 }));
  const [photo, setPhoto] = useState<{ url: string; img: Img } | null>(null);
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
  const colour = ball?.colour ?? '#ffffff';
  const front = useMemo(
    () => artworkDecal(artwork, colour),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logoImg, mode, lines, font, ink, scale, colour],
  );
  const back = useMemo(() => {
    if (!ball) return null;
    if (photo && photo.url === ball.photoUrl) return photoDecal(photo.img);
    return sidestampDecal(ball.brand, ball.name, ball.colour);
  }, [ball, photo]);
  const look: BallLook = useMemo(() => ({ colour, front, back }), [colour, front, back]);

  // Editing the artwork turns the ball round to show it.
  useEffect(() => {
    if (front) setViewState((v) => (v.side === 'logo' ? v : { side: 'logo', q: IDENTITY, n: v.n + 1 }));
  }, [front]);

  // Load the chosen ball's product photo so its real sidestamp can be wrapped onto the ball.
  useEffect(() => {
    if (!ball?.photoUrl || photo?.url === ball.photoUrl) return;
    let live = true;
    loadImage(ball.photoUrl).then((img) => live && setPhoto({ url: ball.photoUrl!, img }), () => undefined);
    return () => {
      live = false;
    };
  }, [ball, photo]);

  const pricePence = parseMoneyToPence(price) ?? 0;
  const setupPence = parseMoneyToPence(setup) ?? 0;
  const total = dozens * pricePence + setupPence;

  const chooseBall = (b: BuilderBall) => {
    setBallId(b.id);
    setPrice(penceToInput(b.pricePerDozenPence));
    setDozens((d) => Math.max(d, b.minDozens));
    setView('brand');
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
      fd.set('proof', await renderProof(look));
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
            <button type="button" role="tab" aria-selected={view.side === 'logo'} className={view.side === 'logo' ? 'on' : ''} onClick={() => setView('logo')}>
              Logo side
            </button>
            <button type="button" role="tab" aria-selected={view.side === 'brand'} className={view.side === 'brand' ? 'on' : ''} onClick={() => setView('brand')} disabled={!ball}>
              Brand side
            </button>
          </div>
          <label className="bp-guide">
            <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> Print area
          </label>
        </div>
        <div className="bp-canvas">
          <BallStage look={look} target={view} guide={guide && view.side === 'logo'} label={ball ? `3D preview of ${ball.brand} ${ball.name} with personalisation` : 'Golf ball preview'} />
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
                  <BallThumb ball={b} />
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
            <button
              type="button"
              className="btn primary"
              disabled={!canNext}
              onClick={() => {
                if (step === 0) setView('logo');
                setStep(step + 1);
              }}
            >
              Next: {STEPS[step + 1]} →
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
