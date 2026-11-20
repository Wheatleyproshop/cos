'use client';

import type { BallPromotion } from '@/db/schema';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

export type RangeBall = {
  id: string;
  brand: string;
  name: string;
  colour: string;
  pricePerDozenPence: number;
};

/** Campaign images are often several MB; shrink in the browser (longest side `max` px, JPEG) so the save stays under the upload limit. */
async function shrink(input: HTMLInputElement, max: number) {
  const file = input.files?.[0];
  if (!file || !file.type.startsWith('image/') || file.size < 500 * 1024) return;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    if (!blob || blob.size >= file.size) return;
    const dt = new DataTransfer();
    dt.items.add(
      new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {
        type: 'image/jpeg',
      }),
    );
    input.files = dt.files;
  } catch {
    /* keep the original; the server checks the size */
  }
}

function ImageField({ name, label, hint, has, max, error }: { name: string; label: string; hint: string; has: boolean; max: number; error?: string }) {
  return (
    <label className="field wide">
      <span>
        {label}
        {has ? ' (leave empty to keep the current one)' : ''}
      </span>
      <input type="file" name={name} accept="image/png,image/jpeg,image/webp" onChange={(e) => void shrink(e.currentTarget, max)} />
      {error ? <span className="err">{error}</span> : <span className="hint">{hint}</span>}
      {has ? (
        <span className="hint">
          <input type="checkbox" name={`remove_${name}`} value="yes" /> Remove the current image
        </span>
      ) : null}
    </label>
  );
}

const pounds = (p: number | undefined) => (p === undefined ? undefined : (p / 100).toFixed(2));
/** For a new promotion, the Titleist Pro V1 family is ticked to start with. */
const suggested = (b: RangeBall) => /titleist/i.test(b.brand) && /pro\s*v1|left\s*dash/i.test(b.name);

/** Set up (or edit) a personalised-ball promotion: its wording, then which balls and at what price. */
export function PromoSetupForm({
  action,
  promo,
  range,
  defaultTerms,
}: {
  action: BoundAction;
  promo?: BallPromotion;
  range: RangeBall[];
  defaultTerms: string;
}) {
  const sorted = [...range].sort((a, b) => Number(suggested(b)) - Number(suggested(a)) || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field
              state={s}
              name="title"
              label="Promotion name"
              required
              defaultValue={promo?.title ?? 'Titleist No.1 Gift in Golf'}
              hint="Shown small above the heading"
            />
            <Field
              state={s}
              name="headline"
              label="Heading customers see"
              defaultValue={promo?.headline ?? 'Personalised Titleist golf balls: the No.1 gift in golf'}
            />
            <Field
              state={s}
              name="closesOn"
              label="Closes on"
              type="date"
              defaultValue={promo?.closesOn ?? ''}
              hint="Optional — the page stops taking designs after this day"
            />
            <Field
              state={s}
              name="setupFee"
              label="Logo setup fee (£)"
              inputMode="decimal"
              defaultValue={pounds(promo?.setupFeePence) ?? '0.00'}
              hint="0 = setup included"
            />
            <Field state={s} name="minDozens" label="Minimum order (dozens)" type="number" min="1" defaultValue={promo?.minDozens ?? 1} />
            <Field
              state={s}
              name="multiBuyDozens"
              label="Multi-buy: dozens"
              type="number"
              min="2"
              defaultValue={promo?.multiBuyDozens ?? ''}
              hint="e.g. 2 — leave empty for no multi-buy"
            />
            <Field
              state={s}
              name="multiBuyPrice"
              label="Multi-buy: price (£)"
              inputMode="decimal"
              defaultValue={pounds(promo?.multiBuyPricePence ?? undefined) ?? ''}
              hint="e.g. 80.00 for 2 dozen; extra dozens at the dozen price"
            />
            <Field
              state={s}
              name="description"
              label="What’s on offer"
              textarea
              wide
              defaultValue={
                promo?.description ??
                'Add your logo, initials or a message to the world’s No.1 golf ball. Choose Pro V1 (white or yellow), Pro V1x or Pro V1x Left Dash, upload your logo and spin the ball to see how it looks.'
              }
            />
          </div>

          <h3 className="team-setup-h">Campaign images</h3>
          <div className="fields">
            <ImageField
              name="banner"
              label="Banner (across the top of the page)"
              hint="A wide image, e.g. the 1920×1080 campaign banner. JPG, PNG or WebP."
              has={Boolean(promo?.bannerKey)}
              max={1920}
              error={s?.fieldErrors?.banner}
            />
            <ImageField
              name="feature"
              label="Feature image (beside the offer)"
              hint="e.g. a gift-box or ball lifestyle photo. Optional."
              has={Boolean(promo?.featureKey)}
              max={1400}
              error={s?.fieldErrors?.feature}
            />
          </div>

          <h3 className="team-setup-h">Balls in the promotion</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Tick each ball and set its promotion price per dozen (inc. VAT). Missing a ball or colour? Add it on the{' '}
            <a href="/ball-printing/range">ball range</a> page first.
          </p>
          {s?.fieldErrors?.balls ? <p className="err">{s.fieldErrors.balls}</p> : null}
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Include</th>
                  <th>Ball</th>
                  <th className="num">Usual price</th>
                  <th>Promotion price (£ a dozen)</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => {
                  const inPromo = promo?.balls.find((x) => x.ballId === b.id);
                  const err = s?.fieldErrors?.[`price_${b.id}`];
                  return (
                    <tr key={b.id}>
                      <td>
                        <input
                          type="checkbox"
                          name={`ball_${b.id}`}
                          value="yes"
                          defaultChecked={promo ? Boolean(inPromo) : suggested(b)}
                          aria-label={`Include ${b.brand} ${b.name}`}
                        />
                      </td>
                      <td>
                        <span
                          className="promo-swatch"
                          style={{
                            background: b.colour,
                            width: 16,
                            height: 16,
                            display: 'inline-block',
                            verticalAlign: 'middle',
                            marginRight: 8,
                          }}
                        />
                        {b.brand} {b.name}
                      </td>
                      <td className="num">£{pounds(b.pricePerDozenPence)}</td>
                      <td>
                        <input
                          name={`price_${b.id}`}
                          inputMode="decimal"
                          defaultValue={pounds(inPromo?.pricePerDozenPence ?? b.pricePerDozenPence)}
                          aria-label={`Promotion price for ${b.brand} ${b.name}`}
                          style={{ maxWidth: 120 }}
                        />
                        {err ? <div className="err">{err}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="fields">
            <Field state={s} name="terms" label="Terms (shown under the designer)" textarea wide defaultValue={promo?.terms ?? defaultTerms} />
          </div>
          <FormMessage state={s} />
          <div className="actions">
            <Submit pendingText="Saving…">{promo ? 'Save changes' : 'Create the promotion link'}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
