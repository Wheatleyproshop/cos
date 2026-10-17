import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { RowLink, SearchBox } from '@/components/chrome';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, stamp } from '@/lib/format';
import { listCustomers } from '@/lib/queries';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const staff = await requireStaff();
  const { q } = await searchParams;
  const rows = await listCustomers(staff.org, q);
  return (
    <>
      <PageHeader
        staff={staff}
        title="Customers."
        sub="Every customer, their orders and the builds they love."
        actions={
          <>
            {hasRole(staff, 'admin') ? (
              <a href="/api/export/customers" className="btn" download>
                ⤓ Export CSV
              </a>
            ) : null}
            <Link href="/customers/import" className="btn">
              Import customers
            </Link>
            <Link href="/orders/new" className="btn primary" scroll={false}>
              ＋ &nbsp; New order
            </Link>
          </>
        }
      />
      <div className="toolbar">
        <Suspense>
          <SearchBox placeholder="Search by name, email, phone or workshop job number…" />
        </Suspense>
      </div>
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th>Active orders</th>
              <th>Total orders</th>
              <th>Lifetime value</th>
              <th>Workshop</th>
              <th>Last order</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r) => (
                <RowLink key={r.c.id} href={`/customers/${r.c.id}`}>
                  <td>
                    <Link href={`/customers/${r.c.id}`} className="rowtitle">
                      {r.c.name}
                    </Link>
                    <div className="muted">{r.c.email}</div>
                  </td>
                  <td>{r.c.phone || '—'}</td>
                  <td>{r.activeOrders}</td>
                  <td>{r.totalOrders}</td>
                  <td>
                    <b>{money(r.lifetimePence)}</b>
                  </td>
                  <td>{r.workshopJobs ? `${r.workshopJobs} job${r.workshopJobs === 1 ? '' : 's'}${r.openWorkshopJobs ? ` (${r.openWorkshopJobs} open)` : ''}` : '—'}</td>
                  <td>{r.lastOrderAt ? stamp(r.lastOrderAt, staff.org.timezone) : '—'}</td>
                </RowLink>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty">
                  {q ? `No customers match “${q}”.` : 'Customers are added automatically when you create an order or quote, or check clubs in to the workshop.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
