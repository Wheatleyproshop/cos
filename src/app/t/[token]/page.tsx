import type { Metadata } from 'next';
import { InvalidLink } from '@/components/public-shell';
import { TrackingView } from '@/components/tracking-view';
import { findOrderByTrackingToken } from '@/lib/services/public';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Your order' }, robots: { index: false } };

export default async function TrackingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ approved?: string }> }) {
  const { token } = await params;
  const { approved } = await searchParams;
  const d = await findOrderByTrackingToken(token);
  if (!d) return <InvalidLink title="This link has expired" body="Please contact the shop and they’ll send you a fresh link to your order." />;
  return (
    <TrackingView
      org={d.org}
      order={d.order}
      customerName={d.customerName}
      paid={d.paid}
      balance={d.balance}
      events={d.events}
      files={d.files}
      token={token}
      approved={Boolean(approved)}
    />
  );
}
