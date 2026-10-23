import type { Metadata } from 'next';
import Link from 'next/link';
import { CrestingBuilder } from '@/components/cresting-builder';
import { PageHeader } from '@/components/views';
import { requireStaff } from '@/lib/auth';
import { crestPrices } from '@/lib/cresting';
import { getBrandOptions, getCustomerDetail } from '@/lib/queries';
import { crestingAction } from '../actions';

export const metadata: Metadata = { title: 'Clothing Cresting' };

export default async function CrestingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  const [brands, cust] = await Promise.all([getBrandOptions(staff.organisationId), customer ? getCustomerDetail(staff.org, customer) : null]);
  return (
    <>
      <PageHeader
        staff={staff}
        title="Clothing Cresting"
        sub="Photograph the garment, add logos or text, and email a proof for sign-off."
        actions={
          <Link href="/cresting/prices" className="btn">
            Cresting prices
          </Link>
        }
      />
      <CrestingBuilder
        prices={crestPrices(staff.org.crestingPrices)}
        action={crestingAction}
        brands={brands}
        defaults={cust ? { customerId: cust.customer.id, customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone } : {}}
      />
    </>
  );
}
