'use client';

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { FormState } from '@/lib/action-utils';
import { LOGO_TYPES, MAX_LOGO_BYTES, PRINT_FONTS, type PrintFontKey } from '@/lib/ball-print';
import {
  APPAREL_SIZES,
  CAP_SIZES,
  CREST_METHODS,
  CREST_POSITIONS,
  THREAD_COLOURS,
  type CrestMethod,
  type CrestPositionKey,
  type CrestPrices,
  type CrestView,
  type GarmentType,
  type ThreadKey,
} from '@/lib/cresting';
import { money, parseMoneyToPence, penceToInput } from '@/lib/format';
import { drawStage, placementBox, renderCrestProof, shrinkPhoto, type DrawPlacement } from './crest-render';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { Field, FormMessage } from './forms';
import { BrandSelect } from './order-forms';

const STEPS = ['Garment', 'Logos & text', 'Sizes & send'];
const MAX_LOGOS = 3;

type Photo = { file: File; image: HTMLImageElement } | null;
type Logo = { file: File; image: HTMLImageElement };
type Placement = {
  id: string;
  position: CrestPositionKey;
  method: CrestMethod;
  colour: ThreadKey;
  x: number;
  y: number;
  w: number;
  kind: 'logo' | 'text';
  logo: number;
  lines: string[];
  font: PrintFontKey;
};

const posOf = (k: string) => CREST_POSITIONS.find((p) => p.key === k)!;

/** The garment photo with its crests; drag a crest to move it. */
function Stage({
  photo, placements, logos, selected, onSelect, onMove, view,
}: {
  photo: Photo; placements: Placement[]; logos: Logo[]; selected: string | null; view: CrestView;
  onSelect: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const draws = useMemo(() => toDraw(placements, logos), [placements, logos]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const px = Math.round((c.clientWidth || 560) * Math.min(window.devicePixelRatio || 1, 2));
    if (c.width !== px) c.width = c.height = px;
    drawStage(c.getContext('2d')!, px, photo?.image ?? null, draws, { selected });
  }, [photo, draws, selected]);

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = at(e);
    const size = e.currentTarget.width;
    const hit = [...draws].reverse().find((d) => {
      const b = placementBox(d, size);
      const px = p.x * size;
      const py = p.y * size;
      return px >= b.x - 10 && px <= b.x + b.w + 10 && py >= b.y - 10 && py <= b.y + b.h + 10;
    });
    onSelect(hit?.id ?? null);
    if (hit) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: hit.id, dx: p.x - hit.x, dy: p.y - hit.y };
    }
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const p = at(e);
    const clamp = (v: number) => Math.min(0.98, Math.max(0.02, v));
    onMove(drag.current.id, clamp(p.x - drag.current.dx), clamp(p.y - drag.current.dy));
  };
  const up = () => (drag.current = null);
  return (
    <div className="cr-stage">
      <canvas
        ref={ref}
        role="img"
        aria-label={`${view === 'front' ? 'Front' : 'Back'} of the garment with ${draws.length} crest${draws.length === 1 ? '' : 's'}. Drag a crest to move it.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      {draws.length ? <span className="bp-hint" aria-hidden="true">✥ Drag a logo to move it</span> : null}
    </div>
  );
}

function toDraw(placements: Placement[], logos: Logo[]): DrawPlacement[] {
  return placements.map((p) => ({
    id: p.id, method: p.method, colour: p.colour, x: p.x, y: p.y, w: p.w,
    art: p.kind === 'logo' ? (logos[p.logo] ? { type: 'logo', image: logos[p.logo].image } : null) : { type: 'text', lines: p.lines, font: p.font },
  }));
}

export function CrestingBuilder({
  prices, action, defaults, brands, variant = 'staff',
}: {
  prices: CrestPrices;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  defaults: PickerDefaults;
  brands: string[];
  /** 'public' = the customer's own design page: no garment price, their own details, sent to the shop to review. */
  variant?: 'staff' | 'public';
}) {
  const isPublic = variant === 'public';
  const [state, formAction, pending] = useActionState(action, null);
  const [step, setStep] = useState(0);
  const [garment, setGarment] = useState<GarmentType>('apparel');
  const [front, setFront] = useState<Photo>(null);
  const [back, setBack] = useState<Photo>(null);
  const [photoError, setPhotoError] = useState('');
  const [description, setDescription] = useState('');
  const [colourName, setColourName] = useState('');
  const [garmentPrice, setGarmentPrice] = useState('');
  const [logos, setLogos] = useState<Logo[]>([]);
  const [logoError, setLogoError] = useState('');
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<CrestView>('front');
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [setup, setSetup] = useState(penceToInput(prices.setupFeePence));
  const [busy, setBusy] = useState(false);

  const positions = CREST_POSITIONS.filter((p) => p.garment === garment);
  const free = positions.filter((p) => !placements.some((x) => x.position === p.key));
  const sel = placements.find((p) => p.id === selected) ?? null;
  const sizeList: readonly string[] = garment === 'cap' ? CAP_SIZES : APPAREL_SIZES;
  const qty = sizeList.reduce((t, s) => t + (sizes[s] ?? 0), 0);
  const garmentPence = parseMoneyToPence(garmentPrice || '0') ?? 0;
  const crestEach = placements.reduce((t, p) => t + prices.positions[p.position][p.method], 0);
  const setupPence = parseMoneyToPence(setup || '0') ?? 0;
  const total = qty * (garmentPence + crestEach) + setupPence;
  const viewPlacements = placements.filter((p) => posOf(p.position).view === view);
  const backLabel = garment === 'cap' ? 'Side' : 'Back';
  const hasArt = placements.length > 0 && placements.every((p) => (p.kind === 'logo' ? Boolean(logos[p.logo]) : p.lines.some((l) => l.trim())));

  const update = (id: string, patch: Partial<Placement>) => setPlacements((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const loadPhoto = async (file: File | undefined, which: 'front' | 'back') => {
    setPhotoError('');
    if (!file) return;
    if (!LOGO_TYPES[file.type]) return setPhotoError('Please use a PNG, JPG or WebP photo.');
    try {
      const shrunk = await shrinkPhoto(file);
      (which === 'front' ? setFront : setBack)(shrunk);
      setView(which);
    } catch (e) {
      setPhotoError((e as Error).message);
    }
  };

  const addLogo = (file: File | undefined, forId?: string) => {
    setLogoError('');
    if (!file) return;
    if (!LOGO_TYPES[file.type]) return setLogoError('Please use a PNG, JPG or WebP logo. A transparent PNG works best.');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('That logo is over 3 MB. Please use a smaller version.');
    if (logos.length >= MAX_LOGOS) return setLogoError(`Up to ${MAX_LOGOS} different logos per job.`);
    const img = new Image();
    const index = logos.length;
    img.onload = () => {
      setLogos((l) => [...l, { file, image: img }]);
      if (forId) update(forId, { kind: 'logo', logo: index });
    };
    img.onerror = () => setLogoError('That logo could not be read.');
    img.src = URL.createObjectURL(file);
  };

  const addPlacement = (key: CrestPositionKey) => {
    const pos = posOf(key);
    const id = Math.random().toString(36).slice(2);
    setPlacements((ps) => [
      ...ps,
      { id, position: key, method: 'embroidery', colour: 'white', x: pos.x, y: pos.y, w: pos.w, kind: logos.length ? 'logo' : 'text', logo: 0, lines: ['', '', ''], font: 'modern' },
    ]);
    setSelected(id);
    setView(pos.view);
  };

  const switchGarment = (g: GarmentType) => {
    if (g === garment) return;
    setGarment(g);
    setPlacements([]);
    setSizes({});
    setSelected(null);
  };

  const canNext = step === 0 ? Boolean(front && description.trim()) : step === 1 ? hasArt : true;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!front || !hasArt) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget);
    fd.set('intent', submitter?.value ?? 'save');
    setBusy(true);
    try {
      const all = toDraw(placements, logos);
      const usesBack = placements.some((p) => posOf(p.position).view === 'back');
      const panels: { label: string; photo: HTMLImageElement | null; placements: DrawPlacement[] }[] = [{ label: 'Front', photo: front.image, placements: all.filter((d) => posOf(placements.find((p) => p.id === d.id)!.position).view === 'front') }];
      if (usesBack) panels.push({ label: backLabel, photo: back?.image ?? null, placements: all.filter((d) => posOf(placements.find((p) => p.id === d.id)!.position).view === 'back') });
      fd.set('proof', await renderCrestProof(panels));
    } finally {
      setBusy(false);
    }
    fd.set('front', front.file);
    if (back) fd.set('back', back.file);
    logos.forEach((l, i) => fd.set(`logo${i}`, l.file));
    fd.set(
      'placements',
      JSON.stringify(
        placements.map((p) => ({
          position: p.position, method: p.method, colour: p.colour, x: +p.x.toFixed(4), y: +p.y.toFixed(4), w: +p.w.toFixed(4),
          artwork: p.kind === 'logo' ? { type: 'logo', logo: p.logo } : { type: 'text', lines: p.lines, font: p.font },
        })),
      ),
    );
    fd.set('sizes', JSON.stringify(Object.fromEntries(sizeList.map((s) => [s, sizes[s] ?? 0]))));
    startTransition(() => formAction(fd));
  };
  const working = pending || busy;

  return (
    <div className="ballprint cresting">
      <section className="bp-stage" aria-label="Live preview">
        <div className="bp-stage-top">
          <div className="seg" role="tablist" aria-label="Garment side">
            <button type="button" role="tab" aria-selected={view === 'front'} className={view === 'front' ? 'on' : ''} onClick={() => setView('front')}>
              Front
            </button>
            <button type="button" role="tab" aria-selected={view === 'back'} className={view === 'back' ? 'on' : ''} onClick={() => setView('back')}>
              {backLabel}
            </button>
          </div>
          {sel ? <span className="muted">{posOf(sel.position).label} selected</span> : null}
        </div>
        <div className="bp-canvas">
          <Stage
            photo={view === 'front' ? front : back}
            placements={viewPlacements}
            logos={logos}
            selected={selected}
            view={view}
            onSelect={setSelected}
            onMove={(id, x, y) => update(id, { x, y })}
          />
        </div>
        <div className="bp-caption">
          {description ? (
            <>
              <b>{description}</b>
              <span>{[colourName, placements.length ? `${placements.length} position${placements.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</span>
            </>
          ) : (
            <span>Upload a photo of the garment to begin</span>
          )}
        </div>
      </section>

      <section className="bp-panel">
        <ol className="stepper bp-steps" aria-label="Cresting steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <button type="button" onClick={() => setStep(i)} disabled={(i >= 1 && !(front && description.trim())) || (i >= 2 && !hasArt)} aria-current={i === step ? 'step' : undefined}>
                <span className="num">{i < step ? '✓' : i + 1}</span>
                <span className="lbl">{s}</span>
              </button>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div>
            <h2>The garment</h2>
            <p className="muted">
              {isPublic
                ? 'Upload a straight-on photo of the garment you’d like crested: one of yours, or one you’d like from the shop. Add the back (or side of a cap) if anything goes there.'
                : 'Take or upload a straight-on photo of the garment. Add the back (or side of a cap) if anything goes there.'}
            </p>
            <div className="seg wide" role="tablist" aria-label="Garment type" style={{ marginTop: 14 }}>
              <button type="button" role="tab" aria-selected={garment === 'apparel'} className={garment === 'apparel' ? 'on' : ''} onClick={() => switchGarment('apparel')}>
                Clothing
              </button>
              <button type="button" role="tab" aria-selected={garment === 'cap'} className={garment === 'cap' ? 'on' : ''} onClick={() => switchGarment('cap')}>
                Cap / hat
              </button>
            </div>
            <div className="cr-photos">
              {(['front', 'back'] as const).map((which) => {
                const ph = which === 'front' ? front : back;
                return (
                  <label key={which} className={`cr-photo${ph ? ' has' : ''}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {ph ? <img src={ph.image.src} alt="" /> : <span aria-hidden="true">＋</span>}
                    <b>{which === 'front' ? 'Front photo *' : `${backLabel} photo (optional)`}</b>
                    <small>{ph ? 'Tap to replace' : 'Tap to upload or take a photo'}</small>
                    <input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" hidden onChange={(e) => loadPhoto(e.target.files?.[0], which)} />
                  </label>
                );
              })}
            </div>
            {photoError ? <p className="error" role="alert">{photoError}</p> : null}
            <div className="fields" style={{ marginTop: 14 }}>
              <label className="field">
                <span>Garment *</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={garment === 'cap' ? 'e.g. Tour cap' : 'e.g. Performance polo'} maxLength={120} />
              </label>
              <label className="field">
                <span>Colour</span>
                <input value={colourName} onChange={(e) => setColourName(e.target.value)} placeholder="e.g. Navy" maxLength={60} />
              </label>
              {isPublic ? null : (
                <label className="field">
                  <span>Garment price each (GBP)</span>
                  <input inputMode="decimal" value={garmentPrice} onChange={(e) => setGarmentPrice(e.target.value)} placeholder="0.00 if the customer supplies it" />
                </label>
              )}
            </div>
          </div>
        ) : step === 1 ? (
          <div>
            <h2>Logos &amp; text</h2>
            <p className="muted">Add each position, choose embroidery or print, then drag it into place on the photo.</p>
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
              {placements.map((p) => {
                const pos = posOf(p.position);
                const on = p.id === selected;
                return (
                  <div key={p.id} className={`cr-item${on ? ' on' : ''}`} onClick={() => { setSelected(p.id); setView(pos.view); }}>
                    <div className="cr-item-head">
                      <b>{pos.label}</b>
                      <span className="muted">{money(prices.positions[p.position][p.method])} each</span>
                      <button type="button" className="btn small" aria-label={`Remove ${pos.label}`} onClick={(e) => { e.stopPropagation(); setPlacements((ps) => ps.filter((x) => x.id !== p.id)); }}>
                        ✕
                      </button>
                    </div>
                    {on ? (
                      <div className="cr-item-body">
                        <div className="seg" role="group" aria-label="Method">
                          {CREST_METHODS.map((m) => (
                            <button key={m.key} type="button" className={p.method === m.key ? 'on' : ''} aria-pressed={p.method === m.key} onClick={() => update(p.id, { method: m.key })}>
                              {m.label}
                            </button>
                          ))}
                        </div>
                        <div className="seg" role="group" aria-label="Artwork">
                          <button type="button" className={p.kind === 'logo' ? 'on' : ''} aria-pressed={p.kind === 'logo'} onClick={() => update(p.id, { kind: 'logo' })}>
                            Logo
                          </button>
                          <button type="button" className={p.kind === 'text' ? 'on' : ''} aria-pressed={p.kind === 'text'} onClick={() => update(p.id, { kind: 'text' })}>
                            Text
                          </button>
                        </div>
                        {p.kind === 'logo' ? (
                          logos.length ? (
                            <div className="cr-logopick">
                              {logos.map((l, i) => (
                                <button key={i} type="button" className={p.logo === i ? 'on' : ''} aria-pressed={p.logo === i} onClick={() => update(p.id, { logo: i })}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={l.image.src} alt={`Logo ${i + 1}`} />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <label className="btn small">
                              ＋ Upload the logo
                              <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => addLogo(e.target.files?.[0], p.id)} />
                            </label>
                          )
                        ) : (
                          <>
                            {p.lines.map((l, i) => (
                              <input
                                key={i}
                                value={l}
                                maxLength={30}
                                aria-label={`Line ${i + 1}`}
                                placeholder={i === 0 ? 'e.g. Wheatley GC Society' : `Line ${i + 1} (optional)`}
                                onChange={(e) => update(p.id, { lines: p.lines.map((x, j) => (j === i ? e.target.value : x)) })}
                              />
                            ))}
                            <select value={p.font} aria-label="Lettering" onChange={(e) => update(p.id, { font: e.target.value as PrintFontKey })}>
                              {PRINT_FONTS.map((f) => (
                                <option key={f.key} value={f.key}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                            <div className="bp-inks" role="group" aria-label={p.method === 'embroidery' ? 'Thread colour' : 'Ink colour'}>
                              {THREAD_COLOURS.map((c) => (
                                <button
                                  key={c.key}
                                  type="button"
                                  className={`bp-ink${p.colour === c.key ? ' selected' : ''}`}
                                  style={{ background: c.hex }}
                                  aria-pressed={p.colour === c.key}
                                  aria-label={c.label}
                                  title={c.label}
                                  onClick={() => update(p.id, { colour: c.key })}
                                />
                              ))}
                            </div>
                          </>
                        )}
                        <label className="bp-size">
                          <span>Size</span>
                          <input type="range" min={0.04} max={pos.key === 'back' ? 0.7 : 0.4} step={0.005} value={p.w} onChange={(e) => update(p.id, { w: Number(e.target.value) })} />
                        </label>
                        <button type="button" className="btn small" onClick={() => update(p.id, { x: pos.x, y: pos.y, w: pos.w })}>
                          Reset position
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {free.length ? (
              <label className="field" style={{ marginTop: 12 }}>
                <span>Add a position</span>
                <select value="" onChange={(e) => e.target.value && addPlacement(e.target.value as CrestPositionKey)}>
                  <option value="">Choose…</option>
                  {free.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label} — embroidery {money(prices.positions[p.key].embroidery)} / print {money(prices.positions[p.key].print)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {placements.some((p) => posOf(p.position).view === 'back') && !back ? (
              <p className="notice warn" style={{ marginTop: 10 }}>
                Add a {backLabel.toLowerCase()} photo in step 1 to show the {backLabel.toLowerCase()} position on the proof.
              </p>
            ) : null}
          </div>
        ) : isPublic && state?.ok ? (
          <div className="bp-thanks" role="status">
            <span className="bp-thanks-tick" aria-hidden="true">✓</span>
            <h2>Design sent</h2>
            <p>{state.message}</p>
          </div>
        ) : isPublic ? (
          <form onSubmit={submit}>
            <h2>Sizes &amp; your details</h2>
            <p className="muted">How many of each size, and how we can reach you. We’ll check everything and confirm the price before anything is made.</p>
            <input type="hidden" name="garmentType" value={garment} />
            <input type="hidden" name="garmentDescription" value={description} />
            <input type="hidden" name="garmentColour" value={colourName} />
            <FormMessage state={state} />
            <div className="cr-sizes" role="group" aria-label="Quantities by size">
              {sizeList.map((s) => (
                <label key={s}>
                  <span>{s}</span>
                  <input
                    inputMode="numeric"
                    value={sizes[s] ?? ''}
                    placeholder="0"
                    onChange={(e) => setSizes((x) => ({ ...x, [s]: Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0) }))}
                  />
                </label>
              ))}
            </div>
            <div className="fields" style={{ marginTop: 14 }}>
              <Field state={state} name="customerName" label="Your name" required autoComplete="name" />
              <Field state={state} name="email" label="Email" type="email" required autoComplete="email" />
              <Field state={state} name="phone" label="Mobile" type="tel" autoComplete="tel" />
              <Field state={state} name="notes" label="Anything we should know?" wide textarea placeholder="e.g. 12 polos for our society day on 14 May. Please supply navy FootJoy polos." />
            </div>
            <label className="bp-hp" aria-hidden="true">
              Website <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
            <div className="bp-total">
              <div>
                <span>
                  Cresting: {qty} item{qty === 1 ? '' : 's'} × {money(crestEach)}
                </span>
                {prices.setupFeePence ? <span>Setup / digitising {money(prices.setupFeePence)}</span> : null}
                <span>Garments extra if we supply them: we’ll confirm</span>
              </div>
              <b>{money(qty * crestEach + prices.setupFeePence)}</b>
            </div>
            <div className="actions">
              <button className="btn primary" type="submit" disabled={working || !qty}>
                {working ? 'Sending…' : 'Send my design for approval →'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit}>
            <h2>Sizes &amp; send</h2>
            <p className="muted">How many of each size, the customer, then save or email the proof for approval.</p>
            <input type="hidden" name="garmentType" value={garment} />
            <input type="hidden" name="garmentDescription" value={description} />
            <input type="hidden" name="garmentColour" value={colourName} />
            <input type="hidden" name="garmentPricePence" value={garmentPrice || '0'} />
            <FormMessage state={state} />
            <div className="cr-sizes" role="group" aria-label="Quantities by size">
              {sizeList.map((s) => (
                <label key={s}>
                  <span>{s}</span>
                  <input
                    inputMode="numeric"
                    value={sizes[s] ?? ''}
                    placeholder="0"
                    onChange={(e) => setSizes((x) => ({ ...x, [s]: Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0) }))}
                  />
                </label>
              ))}
            </div>
            <div className="fields" style={{ marginTop: 14 }}>
              <BrandSelect brands={brands} state={state} defaultValue="" />
              <label className="field">
                <span>Setup / digitising fee (GBP)</span>
                <input name="setupFeePence" inputMode="decimal" value={setup} onChange={(e) => setSetup(e.target.value)} />
              </label>
              <CustomerPicker state={state} defaults={defaults} />
              <Field state={state} name="validUntil" label="Proof valid until" type="date" />
              <Field state={state} name="notes" label="Notes for the customer" wide textarea placeholder="e.g. Logo embroidered in your club colours. Ready about 10 days after approval." />
            </div>
            <div className="bp-total">
              <div>
                <span>
                  {qty} item{qty === 1 ? '' : 's'} × {money(garmentPence + crestEach)}
                  {garmentPence ? ` (garment ${money(garmentPence)} + cresting ${money(crestEach)})` : ''}
                </span>
                {setupPence ? <span>Setup / digitising {money(setupPence)}</span> : null}
              </div>
              <b>{money(total)}</b>
            </div>
            <div className="actions">
              <button className="btn" type="submit" name="intent" value="save" disabled={working || !qty}>
                Save as draft
              </button>
              <button className="btn primary" type="submit" name="intent" value="send" disabled={working || !qty}>
                {working ? 'Creating proof…' : 'Email proof for approval →'}
              </button>
            </div>
          </form>
        )}

        {step < STEPS.length - 1 && !(isPublic && state?.ok) ? (
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
