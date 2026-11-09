import type { Metadata } from 'next';
import { MatEngravingBuilder } from '@/components/mat-engraving-builder';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { matPrices } from '@/lib/mat-engraving';
import { findMatShop } from '@/lib/services/mat-engraving';
import { submitMatDesignAction } from './actions';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Design your personalised fairway mat' } };

export default async function MatDesignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const shop = await findMatShop(slug);
  if (!shop) return <InvalidLink title="This page isn’t available" body="Personalised mats can’t be designed online at the moment. Please contact the shop." />;
  const { org } = shop;
  return (
    <PublicShell org={org} wide>
      <div className="design-intro">
        <h1>Design your personalised fairway mat</h1>
        <p>
          Choose a short or long pile Spurk fairway mat, then add a name or logo to be laser engraved on the front lip or underneath. Send it to
          us and we’ll check the design and confirm the price before anything is engraved.
        </p>
      </div>
      <MatEngravingBuilder variant="public" prices={matPrices(org.matEngraving)} action={submitMatDesignAction.bind(null, org.slug)} defaults={{}} />
    </PublicShell>
  );
}
