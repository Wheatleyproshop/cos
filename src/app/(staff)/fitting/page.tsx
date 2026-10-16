import type { Metadata } from 'next';
import Link from 'next/link';
import { FittingBuilder } from '@/components/fitting-builder';
import { PageHeader } from '@/components/views';
import { requireStaff } from '@/lib/auth';
import { hasFeature } from '@/lib/plans';
import { getCustomerDetail } from '@/lib/queries';
import { getCatalog } from '@/lib/services/fitting';
import { fittingAction } from '../actions';

export const metadata: Metadata = { title: 'Custom Fitting' };

export default async function FittingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  if (!hasFeature(staff.org, 'configure')) {
    return (
      <>
        <PageHeader staff={staff} title="Custom Fitting" sub="Build a personalised specification and create a quote." actions={<span />} />
        <div className="notice warn">Custom Fitting is included in the Pro plan.</div>
      </>
    );
  }
  const [catalog, cust] = await Promise.all([getCatalog(staff.organisationId), customer ? getCustomerDetail(staff.org, customer) : null]);
  return (
    <>
      <PageHeader
        staff={staff}
        title="Custom Fitting"
        sub="Build a personalised specification and create a quote."
        actions={
          <Link href="/products" className="btn">
            Manage catalogue
          </Link>
        }
      />
      {catalog.brands.length && catalog.models.length ? (
        <FittingBuilder
          catalog={catalog}
          action={fittingAction}
          defaults={cust ? { customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone } : {}}
        />
      ) : (
        <div className="panel empty">
          Your fitting catalogue is empty. <Link href="/products">Add brands, heads and components</Link> to start fitting.
        </div>
      )}
    </>
  );
}
