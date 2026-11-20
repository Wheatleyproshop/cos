import type { Metadata } from "next";
import { BallPrintBuilder } from "@/components/ball-print-builder";
import { InvalidLink, PublicShell } from "@/components/public-shell";
import { money } from "@/lib/format";
import {
  findBallPromotion,
  isPromoOpen,
  londonToday,
  promoImagePath,
} from "@/lib/services/ball-promotions";
import { submitPromotionAction } from "./actions";

// Absolute title: customer pages never mention COS. Not for search engines: the link is shared directly.
export const metadata: Metadata = {
  title: { absolute: "Personalised golf balls" },
  robots: { index: false, follow: false },
};

const ukDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export default async function PromotionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const found = await findBallPromotion(token);
  if (!found || !found.balls.length)
    return (
      <InvalidLink
        title="This page isn’t available"
        body="This promotion can’t be found. Please contact the shop."
      />
    );
  const { promo, org, balls } = found;
  const open = isPromoOpen(promo, londonToday());
  return (
    <PublicShell org={org} wide>
      {promo.bannerKey ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="promo-banner"
          src={promoImagePath(promo, "banner")!}
          alt={promo.headline || promo.title}
        />
      ) : null}
      <div className={promo.featureKey ? "promo-top has-feature" : "promo-top"}>
        <div>
          <div className="design-intro promo-intro">
            <p className="promo-eyebrow">{promo.title}</p>
            <h1>{promo.headline || "Personalised golf balls"}</h1>
            {promo.description ? (
              <p style={{ whiteSpace: "pre-line" }}>{promo.description}</p>
            ) : null}
          </div>

          <div className="promo-offer" aria-label="Balls in this promotion">
            {balls.map((b) => (
              <div key={b.id} className="promo-ball">
                <span
                  className="promo-swatch"
                  style={{ background: b.colour }}
                  aria-hidden="true"
                />
                <div>
                  <b>
                    {b.brand} {b.name}
                  </b>
                  <div>
                    {money(b.promoPricePence)} a dozen
                    {b.promoPricePence < b.pricePerDozenPence ? (
                      <span className="promo-was">
                        {" "}
                        usually {money(b.pricePerDozenPence)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            <div className="promo-facts">
              <span>
                {promo.setupFeePence
                  ? `Logo setup ${money(promo.setupFeePence)}`
                  : "Logo setup included"}
              </span>
              {promo.minDozens > 1 ? (
                <span>Minimum {promo.minDozens} dozen</span>
              ) : null}
              {promo.closesOn ? (
                <span>
                  {open
                    ? `Order by ${ukDate(promo.closesOn)}`
                    : `Closed ${ukDate(promo.closesOn)}`}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {promo.featureKey ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="promo-feature"
            src={promoImagePath(promo, "feature")!}
            alt=""
          />
        ) : null}
      </div>

      {open ? (
        <BallPrintBuilder
          variant="public"
          balls={balls.map((b) => ({
            id: b.id,
            brand: b.brand,
            name: b.name,
            colour: b.colour,
            pricePerDozenPence: b.promoPricePence,
            minDozens: Math.max(b.minDozens, promo.minDozens),
            photoUrl: b.photoKey
              ? `/api/public/promo-ball-photo/${promo.token}/${b.id}?v=${b.photoKey.slice(-10)}`
              : null,
          }))}
          setupFeePence={promo.setupFeePence}
          action={submitPromotionAction.bind(null, promo.token)}
          defaults={{}}
        />
      ) : (
        <div className="notice warn">
          This promotion has now closed. Please contact the shop if you’d still
          like personalised balls.
        </div>
      )}

      <p className="promo-terms">{promo.terms}</p>
    </PublicShell>
  );
}
