import type { Metadata } from 'next';
import { OrderDetail } from '@/components/details';
import { NotificationBell } from '@/components/notifications';
import { RefreshButton } from '@/components/refresh-button';
import { requireStaff } from '@/lib/auth';

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).number) };
}

export default async function OrderPage({ params }: { params: Promise<{ number: string }> }) {
  const staff = await requireStaff();
  const { number } = await params;
  return (
    <>
      <div className="top" style={{ justifyContent: 'flex-end', marginBottom: 14, flexDirection: 'row', gap: 10 }}>
        <RefreshButton />
        <NotificationBell />
      </div>
      <div className="pagecard">
      <OrderDetail staff={staff} number={number} inModal={false} />
      </div>
    </>
  );
}
