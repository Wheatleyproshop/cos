import type { Metadata } from 'next';
import { InvalidLink } from '@/components/public-shell';
import { WorkshopTrackingView } from '@/components/workshop-tracking-view';
import { findWorkshopByToken } from '@/lib/services/public';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Your clubs' }, robots: { index: false } };

export default async function WorkshopTrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await findWorkshopByToken(token);
  if (!d) return <InvalidLink title="This link has expired" body="Please contact the shop and they’ll update you on your clubs." />;
  return <WorkshopTrackingView org={d.org} job={d.job} items={d.items} customerName={d.customerName} />;
}
