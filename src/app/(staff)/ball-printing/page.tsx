import type { Metadata } from 'next';
import Link from 'next/link';
import { BallPrintBuilder } from '@/components/ball-print-builder';
import { DesignLinkPanel, SubmittedDesigns } from '@/components/design-link-panel';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { getCustomerDetail } from '@/lib/queries';
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
      <SubmittedDesigns rows={submitted} tz={staff.org.timezone} what="Designs" />
      {balls.length ? (
        <DesignLinkPanel url={appUrl(designPathFor(staff.org))} on={linkOn} manager={manager} toggle={designLinkAction.bind(null, !linkOn)} what="golf balls" />
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
