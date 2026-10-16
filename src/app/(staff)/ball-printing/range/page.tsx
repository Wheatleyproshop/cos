import type { Metadata } from 'next';
import Link from 'next/link';
import { AddBallForm, BallPriceForm, SetupFeeForm } from '@/components/ball-range-forms';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, penceToInput } from '@/lib/format';
import { getBallRange } from '@/lib/services/ball-printing';
import { addBallAction, ballActiveAction, ballPriceAction, setupFeeAction, starterBallsAction } from '../../actions';

export const metadata: Metadata = { title: 'Ball range' };

export default async function BallRangePage() {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const balls = await getBallRange(staff.organisationId, { includeInactive: true });
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
                      <td className="num">{manager ? <BallPriceForm action={ballPriceAction.bind(null, b.id)} value={penceToInput(b.pricePerDozenPence)} /> : money(b.pricePerDozenPence)}</td>
                      <td className="num">
                        {manager ? (
                          <ActionButton action={ballActiveAction.bind(null, b.id, !b.active)} className="btn small">
                            {b.active ? 'Retire' : 'Restore'}
                          </ActionButton>
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
              <AddBallForm action={addBallAction} />
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
        </section>
      </div>
    </>
  );
}
