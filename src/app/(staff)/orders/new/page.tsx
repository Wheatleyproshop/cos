import type { Metadata } from 'next';
import { NewRequest } from '@/components/details';
import { NotificationBell } from '@/components/notifications';
import { requireStaff } from '@/lib/auth';

export const metadata: Metadata = { title: 'New order' };

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaff();
  return (
    <>
      <div className="top" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
        <NotificationBell />
      </div>
      <div className="pagecard">
      <NewRequest staff={staff} inModal={false} params={await searchParams} />
      </div>
    </>
  );
}
