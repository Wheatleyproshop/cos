import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { parseFilter, WorkList } from '@/components/work-list';
import { hasRole, requireStaff } from '@/lib/auth';
import { stamp } from '@/lib/format';
import { listWork } from '@/lib/queries';
import { listDeletedOrders } from '@/lib/services/orders';
import { deleteOrderAction } from '../actions';

export const metadata: Metadata = { title: 'All orders' };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = parseFilter(sp.filter);
  const q = sp.q ?? '';
  const [{ rows }, deleted] = await Promise.all([listWork(staff.org, { q, filter, scope: 'all' }), listDeletedOrders(staff.organisationId)]);
  const manager = hasRole(staff, 'manager');
  return (
    <>
      <PageHeader staff={staff} title="All orders." sub="Track every order from request to collection." />
      <WorkList base="/orders" rows={rows} filter={filter} q={q} showArchived />
      {deleted.length ? (
        <section className="panel" style={{ marginTop: 18 }}>
          <details className="section">
            <summary>Deleted orders ({deleted.length})</summary>
            <ul className="attention">
              {deleted.map((o) => (
                <li key={o.id}>
                  <span>
                    <Link href={`/orders/${o.orderNumber}`} className="rowtitle" scroll={false}>
                      {o.orderNumber} · {o.customer}
                    </Link>
                    <div className="muted">
                      {o.brand} {o.product} · deleted {stamp(o.removedAt!, staff.org.timezone)}
                    </div>
                  </span>
                  {manager ? (
                    <ActionButton action={deleteOrderAction.bind(null, o.id, false)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </>
  );
}
