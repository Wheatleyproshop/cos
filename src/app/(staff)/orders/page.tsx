import type { Metadata } from 'next';
import { PageHeader } from '@/components/views';
import { parseFilter, WorkList } from '@/components/work-list';
import { requireStaff } from '@/lib/auth';
import { listWork } from '@/lib/queries';

export const metadata: Metadata = { title: 'All orders' };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = parseFilter(sp.filter);
  const q = sp.q ?? '';
  const { rows } = await listWork(staff.org, { q, filter, scope: 'all' });
  return (
    <>
      <PageHeader staff={staff} title="All orders." sub="Track every order from request to collection." />
      <WorkList base="/orders" rows={rows} filter={filter} q={q} showArchived />
    </>
  );
}
