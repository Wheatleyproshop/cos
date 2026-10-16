import type { Metadata } from 'next';
import Link from 'next/link';
import { BallPrintBuilder } from '@/components/ball-print-builder';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { getCustomerDetail } from '@/lib/queries';
import { getBallRange } from '@/lib/services/ball-printing';
import { ballPrintAction } from '../actions';

export const metadata: Metadata = { title: 'Ball Printing' };

export default async function BallPrintingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  const [balls, cust] = await Promise.all([getBallRange(staff.organisationId), customer ? getCustomerDetail(staff.org, customer) : null]);
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
