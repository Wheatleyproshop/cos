import type { Metadata } from 'next';
import Link from 'next/link';
import { AddBallForm, BallPhotoForm, BallPriceForm, EditBallButton, SetupFeeForm } from '@/components/ball-range-forms';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { BALL_BRANDS } from '@/lib/ball-print';
import { money, penceToInput } from '@/lib/format';
import { mergeBrands } from '@/lib/order-details';
import { getBallRange } from '@/lib/services/ball-printing';
import { addBallAction, ballActiveAction, ballEditAction, ballPhotoAction, ballPriceAction, setupFeeAction, starterBallsAction } from '../../actions';

export const metadata: Metadata = { title: 'Ball range' };

export default async function BallRangePage() {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const balls = await getBallRange(staff.organisationId, { includeInactive: true });
  // The brands you offer, plus any other brand already on an active ball.
  const brands = mergeBrands(BALL_BRANDS, balls.filter((b) => b.active).map((b) => b.brand));
  return (
    <>
      <PageHeader
        staff={staff}
        title="Ball range."
        sub="The balls you offer for printing, priced per dozen including printing."
        actions={
          <Link href="/ball-printing" className="btn">
            ← Ball Printing
          </Link>
        }
      />
      <div className="split">
        <section className="panel">
          <h2>Balls</h2>
          {balls.length ? (
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th>Ball</th>
                    <th>Photo</th>
                    <th className="num">Per dozen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {balls.map((b) => (
                    <tr key={b.id} style={b.active ? undefined : { opacity: 0.5 }}>
                      <td>
                        <span className="swatch" style={{ background: b.colour }} aria-hidden="true" /> <b>{b.brand} {b.name}</b>
                        <div className="muted">
                          {b.minDozens > 1 ? `Minimum ${b.minDozens} dozen` : 'From 1 dozen'}
                          {b.leadTimeDays ? ` · ${b.leadTimeDays} day lead time` : ''}
                        </div>
                      </td>
                      <td>
                        {manager ? (
                          <BallPhotoForm
                            action={ballPhotoAction.bind(null, b.id)}
                            photoUrl={b.photoKey ? `/api/ball-photo/${b.id}?v=${b.photoKey.slice(-10)}` : null}
                            label={`${b.brand} ${b.name}`}
                          />
                        ) : b.photoKey ? 'Yes' : '—'}
                      </td>
                      <td className="num">{manager ? <BallPriceForm action={ballPriceAction.bind(null, b.id)} value={penceToInput(b.pricePerDozenPence)} /> : money(b.pricePerDozenPence)}</td>
                      <td className="num">
                        {manager ? (
                          <span className="rowbtns">
                            <EditBallButton
                              action={ballEditAction.bind(null, b.id)}
                              label={`${b.brand} ${b.name}`}
                              brands={brands}
                              values={{
                                brand: b.brand, name: b.name, colour: b.colour, price: penceToInput(b.pricePerDozenPence),
                                minDozens: String(b.minDozens), leadTimeDays: b.leadTimeDays ? String(b.leadTimeDays) : '0',
                              }}
                            />
                            <ActionButton action={ballActiveAction.bind(null, b.id, !b.active)} className="btn small">
                              {b.active ? 'Retire' : 'Restore'}
                            </ActionButton>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <p>No balls yet. Add your own below{manager ? ', or start from a popular range and adjust the prices.' : '.'}</p>
              {manager ? (
                <ActionButton action={starterBallsAction} className="btn primary">
                  Add starter range (13 balls)
                </ActionButton>
              ) : null}
            </div>
          )}
          {manager ? (
            <details className="section" open={!balls.length}>
              <summary>Add a ball</summary>
              <AddBallForm action={addBallAction} brands={brands} />
            </details>
          ) : null}
        </section>
        <section className="panel">
          <h2>Pricing</h2>
          {manager ? (
            <SetupFeeForm action={setupFeeAction} value={penceToInput(staff.org.ballSetupFeePence)} />
          ) : (
            <p>Artwork setup fee: {money(staff.org.ballSetupFeePence)}</p>
          )}
          <p className="muted" style={{ marginTop: 16 }}>
            Retired balls disappear from the builder but stay on old quotes and orders.
          </p>
          <h3>Ball photos</h3>
          <p className="muted">
            Add a straight-on product photo of each ball (the side with the brand and model printed on it), ideally on a white or
            transparent background. The builder wraps that print onto the 3D ball, so customers see the real ball. Use photos you
            have the rights to use, such as your supplier’s retailer images or your own.
          </p>
        </section>
      </div>
    </>
  );
}
