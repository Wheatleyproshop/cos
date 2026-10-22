import type { Metadata } from 'next';
import Link from 'next/link';
import { BallPrintBuilder } from '@/components/ball-print-builder';
import { CopyLink } from '@/components/copy-link';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { getCustomerDetail } from '@/lib/queries';
import { money, stamp } from '@/lib/format';
import { designPathFor, getBallRange, listSubmittedDesigns } from '@/lib/services/ball-printing';
import { appUrl } from '@/lib/tokens';
import { ballPrintAction, designLinkAction } from '../actions';

export const metadata: Metadata = { title: 'Ball Printing' };

export default async function BallPrintingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  const [balls, cust, submitted] = await Promise.all([
    getBallRange(staff.organisationId),
    customer ? getCustomerDetail(staff.org, customer) : null,
    listSubmittedDesigns(staff.organisationId),
  ]);
  const manager = hasRole(staff, 'manager');
  const linkOn = staff.org.ballDesignLink;
  return (
    <>
      <PageHeader
        staff={staff}
        title="Ball Printing"
        sub="Personalised golf balls: choose a ball, add a logo or text, and email a proof for approval."
        actions={
          <Link href="/ball-printing/range" className="btn">
            Manage ball range
          </Link>
        }
      />
      {submitted.length ? (
        <section className="panel">
          <h2>Designs sent in by customers · {submitted.length} to review</h2>
          <p className="muted" style={{ marginTop: 0 }}>Open one to check the artwork, then approve it in store to put it into print, or edit it and email a proof back.</p>
          <ul className="attention">
            {submitted.map((d) => (
              <li key={d.quoteNumber}>
                <span>
                  <Link href={`/quotes/${d.quoteNumber}`} className="rowtitle">
                    {d.customer} · {d.brand} {d.product}
                  </Link>
                  <div className="muted">
                    {d.quoteNumber} · sent {stamp(d.createdAt, staff.org.timezone)}
                  </div>
                </span>
                <span className="muted">{money(d.totalGrossPence)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {balls.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Customer design link</h2>
            <span className={`badge ${linkOn ? 'ready' : 'pb-cancelled'}`}>{linkOn ? 'On' : 'Off'}</span>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            {linkOn
              ? 'Share this on your website, socials or by email. Customers design their own balls and send them to you to check. You’ll get an email and a notification for each one.'
              : 'Switched off: customers who open the link are asked to contact the shop.'}
          </p>
          {linkOn ? <CopyLink url={appUrl(designPathFor(staff.org))} label="Customer design link" /> : null}
          {manager ? (
            <div style={{ marginTop: 10 }}>
              <ActionButton action={designLinkAction.bind(null, !linkOn)} className="btn small">
                {linkOn ? 'Switch link off' : 'Switch link on'}
              </ActionButton>
            </div>
          ) : null}
        </section>
      ) : null}
      {balls.length ? (
        <BallPrintBuilder
          balls={balls.map((b) => ({
            id: b.id, brand: b.brand, name: b.name, colour: b.colour, pricePerDozenPence: b.pricePerDozenPence, minDozens: b.minDozens,
            photoUrl: b.photoKey ? `/api/ball-photo/${b.id}?v=${b.photoKey.slice(-10)}` : null,
          }))}
          setupFeePence={staff.org.ballSetupFeePence}
          action={ballPrintAction}
          defaults={cust ? { customerId: cust.customer.id, customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone } : {}}
        />
      ) : (
        <div className="panel empty">
          You haven’t added any balls yet.{' '}
          {hasRole(staff, 'manager') ? <Link href="/ball-printing/range">Set up your ball range</Link> : 'Ask a manager to set up the ball range.'} to start
          printing.
        </div>
      )}
    </>
  );
}
