import type { Metadata } from 'next';
import { BallPrintBuilder } from '@/components/ball-print-builder';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { findDesignShop, publicBallPhotoPath } from '@/lib/services/ball-printing';
import { submitDesignAction } from './actions';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Design your personalised golf balls' } };

export default async function DesignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const shop = await findDesignShop(slug);
  if (!shop) return <InvalidLink title="This page isn’t available" body="Personalised golf balls can’t be designed online at the moment. Please contact the shop." />;
  const { org, balls } = shop;
  return (
    <PublicShell org={org} wide>
      <div className="design-intro">
        <h1>Design your personalised golf balls</h1>
        <p>
          Choose your ball, add your logo or a message, and spin the ball to see how it looks. Send it to us and we’ll check the artwork and confirm with
          you before anything is printed.
        </p>
      </div>
      <BallPrintBuilder
        variant="public"
        balls={balls.map((b) => ({
          id: b.id, brand: b.brand, name: b.name, colour: b.colour, pricePerDozenPence: b.pricePerDozenPence, minDozens: b.minDozens,
          photoUrl: b.photoKey ? publicBallPhotoPath(org, b.id, b.photoKey) : null,
        }))}
        setupFeePence={org.ballSetupFeePence}
        action={submitDesignAction.bind(null, org.slug)}
        defaults={{}}
      />
    </PublicShell>
  );
}
