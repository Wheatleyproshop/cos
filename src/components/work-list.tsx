import Link from 'next/link';
import { Suspense } from 'react';
import { FILTERS, type FilterKey, type WorkRow } from '@/lib/queries';
import { SearchBox } from './chrome';
import { WorkTable } from './views';

const VALID = new Set<string>([...FILTERS.map((f) => f.key), 'active', 'awaiting', 'overdue', 'archived']);

export function parseFilter(v: string | undefined, fallback: FilterKey = 'all'): FilterKey {
  return v && VALID.has(v) ? (v as FilterKey) : fallback;
}

const EXTRA_LABELS: Record<string, string> = { active: 'Active', awaiting: 'Awaiting supplier', overdue: 'Delayed / overdue', archived: 'Archived' };

export function WorkList({
  base,
  rows,
  filter,
  q,
  showArchived,
  viewAll,
}: {
  base: string;
  rows: WorkRow[];
  filter: FilterKey;
  q: string;
  showArchived?: boolean;
  viewAll?: boolean;
}) {
  const href = (key: string) => {
    const p = new URLSearchParams();
    if (key !== 'all') p.set('filter', key);
    if (q) p.set('q', q);
    return `${base}${p.size ? `?${p}` : ''}`;
  };
  const pills: { key: string; label: string }[] = [...FILTERS];
  if (!FILTERS.some((f) => f.key === filter)) pills.splice(1, 0, { key: filter, label: EXTRA_LABELS[filter] ?? filter });
  if (showArchived && filter !== 'archived') pills.push({ key: 'archived', label: 'Archived' });
  return (
    <>
      <div className="toolbar">
        <Suspense>
          <SearchBox placeholder="Search customer, email, phone, order ID, brand, product, SKU or supplier ref…" />
        </Suspense>
        {viewAll ? (
          <Link className="btn" href="/orders">
            View all →
          </Link>
        ) : null}
      </div>
      <nav className="pills" aria-label="Filter orders">
        {pills.map((p) => (
          <Link key={p.key} href={href(p.key)} className={`pill${filter === p.key ? ' selected' : ''}`} aria-current={filter === p.key ? 'true' : undefined} scroll={false}>
            {p.label}
          </Link>
        ))}
      </nav>
      <WorkTable
        rows={rows}
        empty={
          q ? (
            <>No matches for “{q}”. Try a customer’s phone number, an order ID or a supplier reference.</>
          ) : (
            <>
              No matching orders. Try a different filter or <Link href="/orders/new">create an order</Link>.
            </>
          )
        }
      />
    </>
  );
}
