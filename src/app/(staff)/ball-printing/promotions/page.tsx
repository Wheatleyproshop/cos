import type { Metadata } from 'next';
import Link from 'next/link';
import { PromoSetupForm } from '@/components/promo-setup-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { getBallRange } from '@/lib/services/ball-printing';
import { DEFAULT_PROMO_TERMS, isPromoOpen, listBallPromotions, londonToday } from '@/lib/services/ball-promotions';
import { createPromotionAction } from './actions';

export const metadata: Metadata = { title: 'Ball promotions' };

export default async function BallPromotionsPage() {
  const staff = await requireStaff();
  const [list, range] = await Promise.all([listBallPromotions(staff.organisationId), getBallRange(staff.organisationId)]);
  const today = londonToday();
  const manager = hasRole(staff, 'manager');
  return (
    <>
      <PageHeader
        staff={staff}
        title="Ball promotions"
        sub="A link for a personalised-ball promotion, such as Titleist’s No.1 Gift in Golf: customers design their logo ball on the chosen balls at promotion prices, and each design comes in as a quote for you to check."
        actions={
          <Link href="/ball-printing" className="btn">
            Ball Printing
          </Link>
        }
      />
      <section className="panel">
        {list.length ? (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Promotion</th>
                  <th className="num">Designs</th>
                  <th className="num">Dozens</th>
                  <th className="num">Value</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/ball-printing/promotions/${p.id}`} className="rowtitle">
                        {p.title}
                      </Link>
                      <div className="muted">{p.ballNames.join(', ')}</div>
                    </td>
                    <td className="num">{p.count}</td>
                    <td className="num">{p.dozens}</td>
                    <td className="num">{money(p.value)}</td>
                    <td>{isPromoOpen(p, today) ? (p.closesOn ? `Open until ${p.closesOn.split('-').reverse().join('/')}` : 'Open') : <span className="muted">Closed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No promotions yet.
          </p>
        )}
      </section>
      {manager ? (
        <section className="panel">
          <h2>New promotion link</h2>
          {range.length ? (
            <PromoSetupForm
              action={createPromotionAction}
              range={range.map((b) => ({ id: b.id, brand: b.brand, name: b.name, colour: b.colour, pricePerDozenPence: b.pricePerDozenPence }))}
              defaultTerms={DEFAULT_PROMO_TERMS}
            />
          ) : (
            <p className="muted">
              Add your balls on the <Link href="/ball-printing/range">ball range</Link> page first.
            </p>
          )}
        </section>
      ) : null}
    </>
  );
}
