import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { systemDb } from '@/db';
import { organisations } from '@/db/schema';
import { QuoteView } from '@/components/quote-view';
import { TrackingView } from '@/components/tracking-view';
import { addDays, todayInTz } from '@/lib/format';

export const metadata: Metadata = { title: { absolute: 'Preview' }, robots: { index: false, follow: false } };

/**
 * What a customer sees, filled with SAMPLE data only (never real orders), in the shop's branding.
 * Linked from staff test emails so the buttons lead somewhere meaningful.
 */
export default async function PreviewPage({ params }: { params: Promise<{ kind: string; slug: string }> }) {
  const { kind, slug } = await params;
  if (kind !== 'track' && kind !== 'quote') notFound();
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.slug, slug)).limit(1);
  if (!org) notFound();

  const today = todayInTz(org.timezone);
  const banner = (
    <div className="notice warn" role="status">
      <b>Preview with sample details</b>
      This is how the page looks to your customers. Real emails link to each customer’s own order.
    </div>
  );
  const sample = {
    brand: 'PING', product: 'G440 MAX Driver', sku: 'PING-G440-MAX',
    specificationText: '10.5° / Alta CB Blue 50 Stiff / Golf Pride MCC +4', totalGrossPence: 52900,
  };
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  if (kind === 'quote') {
    return (
      <QuoteView
        org={org}
        banner={banner}
        customerName="James Wilson"
        quote={{ ...sample, quoteNumber: 'Q-0000', depositRequiredPence: 10000, estimatedLeadTime: '2–3 weeks', validUntil: addDays(today, 14) }}
        action={
          <button className="btn primary" type="button" disabled style={{ width: '100%', marginTop: 20 }}>
            Approve quote and place order (disabled in preview)
          </button>
        }
      />
    );
  }

  return (
    <TrackingView
      org={org}
      banner={banner}
      customerName="James Wilson"
      paid={10000}
      balance={42900}
      files={[]}
      token={null}
      order={{ ...sample, orderNumber: 'COS-0000', status: 'ordered', etaDate: addDays(today, 7), etaReason: '', createdAt: ago(2) }}
      events={[
        { eventType: 'order_created', oldValueJson: null, newValueJson: null, createdAt: ago(2) },
        { eventType: 'status_changed', oldValueJson: { status: 'place_order' }, newValueJson: { status: 'ordered' }, createdAt: ago(2) },
      ]}
    />
  );
}
