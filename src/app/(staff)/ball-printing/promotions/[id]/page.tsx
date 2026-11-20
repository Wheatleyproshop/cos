import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyLink } from '@/components/copy-link';
import { ActionButton } from '@/components/forms';
import { PromoSetupForm } from '@/components/promo-setup-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { getBallRange } from '@/lib/services/ball-printing';
import { ballPromotionDetail, DEFAULT_PROMO_TERMS, isPromoOpen, londonToday } from '@/lib/services/ball-promotions';
import { payStatesForQuotes } from '@/lib/services/shopify-invoices';
import { appUrl } from '@/lib/tokens';
import { closePromotionAction, updatePromotionAction } from '../actions';

export const metadata: Metadata = { title: 'Ball promotion' };

const QUOTE_STATUS: Record<string, string> = {
  draft: 'To check',
  sent: 'Proof sent',
  accepted: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export default async function BallPromotionPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const [d, range] = await Promise.all([ballPromotionDetail(staff.organisationId, id), getBallRange(staff.organisationId)]);
  if (!d) notFound();
  const pay = await payStatesForQuotes(staff.organisationId, d.designs.map((x) => x.id));
  const { promo } = d;
  const open = isPromoOpen(promo, londonToday());
  const manager = hasRole(staff, 'manager');
  const url = appUrl(`/promo/${promo.token}`);
  return (
    <>
      <PageHeader
        staff={staff}
        title={promo.title}
        sub={`${d.balls.map((b) => `${b.name} ${money(b.pricePerDozenPence)}/dz`).join(', ')} · ${promo.setupFeePence ? `setup ${money(promo.setupFeePence)}` : 'setup included'}`}
        actions={
          <Link href="/ball-printing/promotions" className="btn">
            All promotions
          </Link>
        }
      />
      <section className="panel">
        <h2>Promotion link {open ? '' : <span className="muted">(closed)</span>}</h2>
        <CopyLink url={url} label="Promotion link" />
        <p className="muted" style={{ marginBottom: 0 }}>
          Share this on the website, social media or by email. Customers pick one of the promotion balls, add their logo or text, spin the 3D ball to check it
          and send it. Each design arrives as a ball-printing quote marked “To check”, at the promotion price, and the customer gets a confirmation email.
          {promo.closesOn ? ` Closes at the end of ${promo.closesOn.split('-').reverse().join('/')}.` : ''}
        </p>
        {manager ? (
          <div className="actions" style={{ marginTop: 12 }}>
            <ActionButton action={closePromotionAction.bind(null, promo.id, open)} confirm={open ? 'Stop this page taking designs?' : undefined}>
              {open ? 'Close the promotion' : 'Reopen the promotion'}
            </ActionButton>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="sheet-head">
          <h2 style={{ margin: 0 }}>
            {d.totals.designs} {d.totals.designs === 1 ? 'design' : 'designs'} · {d.totals.dozens} dozen · {money(d.totals.value)}
          </h2>
          {d.totals.designs ? (
            <a className="btn small" href={`/api/export/ball-promotion/${promo.id}`}>
              Download list (CSV)
            </a>
          ) : null}
        </div>
        <div className="team-tally" aria-label="Dozens per ball">
          {d.balls.map((b) => (
            <div key={b.ballId}>
              <span className="muted">{b.name}</span>
              <b>{b.dozens}</b>
              <small className="muted">
                dozen · {b.designs} {b.designs === 1 ? 'design' : 'designs'}
              </small>
              {b.left !== null ? (
                <small className={b.left === 0 ? 'err' : 'muted'}>
                  {b.left === 0 ? `Sold out (${b.stockDozens} dozen)` : `${b.left} of ${b.stockDozens} dozen left`}
                </small>
              ) : null}
            </div>
          ))}
        </div>
        {d.designs.length ? (
          <div className="tablewrap" style={{ marginTop: 16 }}>
            <table className="compact">
              <thead>
                <tr>
                  <th>Quote</th>
                  <th>Customer</th>
                  <th>Ball</th>
                  <th className="num">Dozens</th>
                  <th>Personalisation</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.designs.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/quotes/${x.quoteNumber}`} className="rowtitle">
                        {x.quoteNumber}
                      </Link>
                    </td>
                    <td>
                      {x.customer}
                      <div className="muted">{x.email}</div>
                    </td>
                    <td>{x.ball}</td>
                    <td className="num">{x.dozens}</td>
                    <td>{x.artwork}</td>
                    <td className="num">{money(x.totalGrossPence)}</td>
                    <td>
                      {pay.get(x.id) ? (
                        <span className={pay.get(x.id)!.overdue ? 'flag' : undefined}>{pay.get(x.id)!.label}</span>
                      ) : x.convertedOrderId ? (
                        'Ordered'
                      ) : (
                        (QUOTE_STATUS[x.status] ?? x.status)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No designs yet.</p>
        )}
      </section>

      {manager ? (
        <details className="panel">
          <summary>
            <b>Edit the promotion</b>
          </summary>
          <PromoSetupForm
            action={updatePromotionAction.bind(null, promo.id)}
            promo={promo}
            range={range.map((b) => ({ id: b.id, brand: b.brand, name: b.name, colour: b.colour, pricePerDozenPence: b.pricePerDozenPence }))}
            defaultTerms={DEFAULT_PROMO_TERMS}
          />
        </details>
      ) : null}
    </>
  );
}
