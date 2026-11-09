import type { Metadata } from 'next';
import Link from 'next/link';
import { DesignLinkPanel } from '@/components/design-link-panel';
import { InHouseWork } from '@/components/in-house-work';
import { MatEngravingBuilder } from '@/components/mat-engraving-builder';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { matPrices } from '@/lib/mat-engraving';
import { getCustomerDetail } from '@/lib/queries';
import { matCasePhotoPath, matDesignPathFor } from '@/lib/services/mat-engraving';
import { inHouseWork } from '@/lib/services/online-designs';
import { appUrl } from '@/lib/tokens';
import { matDesignLinkAction, matEngravingAction } from '../actions';

export const metadata: Metadata = { title: 'Mat Engraving' };

export default async function MatEngravingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const staff = await requireStaff();
  const { customer } = await searchParams;
  const [cust, work] = await Promise.all([customer ? getCustomerDetail(staff.org, customer) : null, inHouseWork(staff.organisationId, 'engraving')]);
  const linkOn = staff.org.matDesignLink;
  return (
    <>
      <PageHeader
        staff={staff}
        title="Mat Engraving"
        sub="Laser-engrave a name or logo on fairway mats: on the front lip, or underneath. Email a proof for sign-off."
        actions={
          <Link href="/engraving/prices" className="btn">
            Engraving prices
          </Link>
        }
      />
      <InHouseWork
        work={work}
        paymentTracking={staff.org.paymentTracking}
        ready={{ text: 'Engraved ✓', verb: 'engraved' }}
        what={{ proofs: 'Proofs & online designs', jobs: 'Being engraved' }}
      />
      <DesignLinkPanel
        url={appUrl(matDesignPathFor(staff.org))}
        on={linkOn}
        manager={hasRole(staff, 'manager')}
        toggle={matDesignLinkAction.bind(null, !linkOn)}
        what="engraved fairway mats"
      />
      <MatEngravingBuilder casePhotoUrl={matCasePhotoPath(staff.org)}
        prices={matPrices(staff.org.matEngraving)}
        action={matEngravingAction}
        defaults={cust ? { customerId: cust.customer.id, customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone } : {}}
      />
    </>
  );
}
