import type { Metadata } from 'next';
import { CrestingBuilder } from '@/components/cresting-builder';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { crestPrices } from '@/lib/cresting';
import { findCrestShop } from '@/lib/services/cresting';
import { submitCrestDesignAction } from './actions';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Design your personalised clothing' } };

export default async function ClothingDesignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const shop = await findCrestShop(slug);
  if (!shop) return <InvalidLink title="This page isn’t available" body="Personalised clothing can’t be designed online at the moment. Please contact the shop." />;
  const { org } = shop;
  return (
    <PublicShell org={org} wide>
      <div className="design-intro">
        <h1>Design your personalised clothing</h1>
        <p>
          Upload a photo of the garment, add your logo or a name, choose embroidery or print, and drag it into place. Send it to us and we’ll check
          the artwork and confirm the price before anything is made.
        </p>
      </div>
      <CrestingBuilder
        variant="public"
        prices={crestPrices(org.crestingPrices)}
        action={submitCrestDesignAction.bind(null, org.slug)}
        brands={[]}
        defaults={{}}
      />
    </PublicShell>
  );
}
