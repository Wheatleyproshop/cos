import type { Metadata } from 'next';
import Link from 'next/link';
import { CrestingBuilder } from '@/components/cresting-builder';
import { DesignLinkPanel, SubmittedDesigns } from '@/components/design-link-panel';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { crestPrices } from '@/lib/cresting';
import { getBrandOptions, getCustomerDetail } from '@/lib/queries';
import { crestDesignPathFor } from '@/lib/services/cresting';
import { listSubmittedDesigns } from '@/lib/services/online-designs';
import { appUrl } from '@/lib/tokens';
import { crestDesignLinkAction, crestingAction } from '../actions';

export const metadata: Metadata = { title: 'Clothing Cresting' };

export default async function CrestingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  const [brands, cust, submitted] = await Promise.all([
    getBrandOptions(staff.organisationId),
    customer ? getCustomerDetail(staff.org, customer) : null,
    listSubmittedDesigns(staff.organisationId, 'cresting'),
  ]);
  const linkOn = staff.org.crestDesignLink;
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
      <SubmittedDesigns rows={submitted} tz={staff.org.timezone} what="Cresting designs" />
      <DesignLinkPanel
        url={appUrl(crestDesignPathFor(staff.org))}
        on={linkOn}
        manager={hasRole(staff, 'manager')}
        toggle={crestDesignLinkAction.bind(null, !linkOn)}
        what="crested clothing"
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
