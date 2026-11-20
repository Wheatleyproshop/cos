import type { Metadata } from 'next';
import { BallPrintBuilder } from '@/components/ball-print-builder';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { money } from '@/lib/format';
import { findBallPromotion, isPromoOpen, londonToday, promoImagePath, promoMultiBuy, promoSoldOut } from '@/lib/services/ball-promotions';
import { submitPromotionAction } from './actions';

// Absolute title: customer pages never mention COS. Not for search engines: the link is shared directly.
export const metadata: Metadata = {
  title: { absolute: 'Personalised golf balls' },
  robots: { index: false, follow: false },
};

const ukDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export default async function PromotionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await findBallPromotion(token);
  if (!found || !found.balls.length) return <InvalidLink title="This page isn’t available" body="This promotion can’t be found. Please contact the shop." />;
  const { promo, org, balls } = found;
  const soldOut = promoSoldOut(balls);
  const open = isPromoOpen(promo, londonToday()) && !soldOut;
  const available = balls.filter((b) => b.left === null || b.left > 0);
  // Every ball in the picker shows a standard Pro V1 photo: the yellow one for yellow balls, the white one for the rest.
  const isYellow = (b: { name: string; colour: string }) => {
    if (/yellow/i.test(b.name)) return true;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b.colour);
    if (!m) return false;
    const [r, g, bl] = m.slice(1).map((h) => parseInt(h, 16));
    return r > 200 && g > 180 && bl < 120;
  };
  const photoOf = (b: (typeof balls)[number]) => (b.photoKey ? `/api/public/promo-ball-photo/${promo.token}/${b.id}?v=${b.photoKey.slice(-10)}` : null);
  const standard = (yellow: boolean) => balls.find((b) => b.photoKey && isYellow(b) === yellow && /^pro\s*v1(\s+yellow)?$/i.test(b.name.trim()));
  const whitePhoto = standard(false);
  const yellowPhoto = standard(true);
  const multiBuy = promoMultiBuy(promo);
  return (
    <PublicShell org={org} wide>
      {promo.bannerKey ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="promo-banner" src={promoImagePath(promo, 'banner')!} alt={promo.headline || promo.title} />
      ) : null}
      <div className={promo.featureKey ? 'promo-top has-feature' : 'promo-top'}>
        <div>
          <div className="design-intro promo-intro">
            <p className="promo-eyebrow">{promo.title}</p>
            <h1>{promo.headline || 'Personalised golf balls'}</h1>
            {promo.description ? <p style={{ whiteSpace: 'pre-line' }}>{promo.description}</p> : null}
          </div>

          <div className="promo-offer" aria-label="Balls in this promotion">
            {balls.map((b) => (
              <div key={b.id} className={b.left === 0 ? 'promo-ball sold' : 'promo-ball'}>
                <span className="promo-swatch" style={{ background: b.colour }} aria-hidden="true" />
                <div>
                  <b>
                    {b.brand} {b.name}
                  </b>
                  <div>
                    {money(b.promoPricePence)} a dozen
                    {b.promoPricePence < b.pricePerDozenPence ? <span className="promo-was"> usually {money(b.pricePerDozenPence)}</span> : null}
                  </div>
                  {b.left === 0 ? (
                    <small className="promo-left out">Sold out</small>
                  ) : b.left !== null ? (
                    <small className="promo-left">{b.left <= 10 ? `Only ${b.left} dozen left` : `${b.left} dozen left`}</small>
                  ) : null}
                </div>
              </div>
            ))}
            <div className="promo-facts">
              {multiBuy ? (
                <span className="promo-deal">
                  {multiBuy.dozens} dozen for {money(multiBuy.pricePence)}
                </span>
              ) : null}
              <span>{promo.setupFeePence ? `Logo setup ${money(promo.setupFeePence)}` : 'Free personalisation'}</span>
              {promo.minDozens > 1 ? <span>Minimum {promo.minDozens} dozen</span> : null}
              {balls.some((b) => b.left !== null) ? <span>While stocks last</span> : null}
              {promo.closesOn ? <span>{open ? `Order by ${ukDate(promo.closesOn)}` : `Closed ${ukDate(promo.closesOn)}`}</span> : null}
            </div>
          </div>
        </div>
        {promo.featureKey ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="promo-feature" src={promoImagePath(promo, 'feature')!} alt="" />
        ) : null}
      </div>

      {open ? (
        <BallPrintBuilder
          variant="public"
          balls={available.map((b) => ({
            id: b.id,
            brand: b.brand,
            name: b.name,
            colour: b.colour,
            pricePerDozenPence: b.promoPricePence,
            minDozens: Math.max(b.minDozens, promo.minDozens),
            maxDozens: b.left,
            photoUrl: (() => {
              const ref = isYellow(b) ? yellowPhoto : whitePhoto;
              return ref ? photoOf(ref) : photoOf(b);
            })(),
          }))}
          setupFeePence={promo.setupFeePence}
          multiBuy={multiBuy}
          action={submitPromotionAction.bind(null, promo.token)}
          defaults={{}}
        />
      ) : (
        <div className="notice warn">
          {soldOut ? 'This promotion has sold out — thank you! ' : 'This promotion has now closed. '}Please contact the shop if you’d still like personalised
          balls.
        </div>
      )}

      <p className="promo-terms">{promo.terms}</p>
    </PublicShell>
  );
}
