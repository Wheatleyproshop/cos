import Link from 'next/link';
import { quickMoveAction, quickPlaceAction } from '@/app/(staff)/actions';
import { money } from '@/lib/format';
import { ArrivedQuick, CollectedQuick, PlaceQuick } from './board-actions';
import type { WorkRow } from '@/lib/queries';
import { shortDate } from '@/lib/short-date';

const DAY = 86_400_000;
const ago = (d: Date, now: number) => {
  const days = Math.floor((now - d.getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

type Col = { key: string; title: string; hint: string; href: string; rows: WorkRow[]; empty: string };

/** The order pad at a glance: what needs placing, what's on order, what's waiting to be collected. */
export function OrderBoard({ rows, today, paymentTracking }: { rows: WorkRow[]; today: string; paymentTracking: boolean }) {
  const now = Date.now();
  const orders = rows.filter((r) => r.kind === 'order' && !r.archived);
  const cols: Col[] = [
    {
      key: 'place', title: 'To place', hint: 'Taken from the customer, not yet ordered', href: '/?filter=place_order', empty: 'Nothing waiting to be placed.',
      rows: orders.filter((r) => r.status === 'place_order').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    },
    {
      key: 'placed', title: 'Placed', hint: 'On order with the supplier', href: '/?filter=placed', empty: 'Nothing on order.',
      rows: orders
        .filter((r) => r.status === 'ordered' || r.status === 'delayed')
        .sort((a, b) => Number(b.status === 'delayed') - Number(a.status === 'delayed') || (a.date ?? '9999').localeCompare(b.date ?? '9999')),
    },
    {
      key: 'ready', title: 'Ready for collection', hint: 'In the shop, customer told', href: '/?filter=ready', empty: 'Nothing waiting to be collected.',
      rows: orders.filter((r) => r.status === 'ready').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    },
  ];
  return (
    <div className="board" aria-label="Order pad">
      {cols.map((c) => (
        <section key={c.key} className={`boardcol bc-${c.key}`} aria-labelledby={`bc-${c.key}`}>
          <header>
            <Link href={c.href} scroll={false} id={`bc-${c.key}`}>
              {c.title}
            </Link>
            <b>{c.rows.length}</b>
          </header>
          <p className="muted">{c.hint}</p>
          {c.rows.length ? (
            <ul>
              {c.rows.slice(0, 8).map((r) => {
                const late = r.status !== 'ready' && r.date && r.date < today;
                const owed = paymentTracking && (r.balancePence ?? 0) > 0 ? money(r.balancePence!) : null;
                return (
                  <li key={r.id}>
                    <Link href={`/orders/${r.number}`} scroll={false}>
                      <span className="bc-top">
                        <b>{r.customerName}</b>
                        <small>{r.number}</small>
                      </span>
                      <span className="bc-item">
                        {r.brand} {r.product}
                      </span>
                      <span className="bc-meta">
                        {c.key === 'place' ? (
                          <span className={r.flags.some((f) => f.code === 'not_placed') ? 'flag' : ''}>Taken {ago(r.createdAt, now)}</span>
                        ) : c.key === 'placed' ? (
                          r.status === 'delayed' ? (
                            <span className="flag">Out of stock{r.date ? ` · exp. ${shortDate(r.date)}` : ''}</span>
                          ) : (
                            <span className={late ? 'flag' : ''}>{r.date ? `${late ? 'Was due' : 'ETA'} ${shortDate(r.date)}` : 'No ETA'}</span>
                          )
                        ) : (
                          <span className={r.flags.some((f) => f.code === 'uncollected') ? 'flag' : ''}>
                            {r.flags.find((f) => f.code === 'uncollected')?.label ?? 'Waiting to collect'}
                          </span>
                        )}
                        <span>{owed && c.key === 'ready' ? `${owed} to pay` : money(r.totalPence)}</span>
                      </span>
                    </Link>
                    <div className="bc-actions">
                      {c.key === 'place' ? (
                        <PlaceQuick action={quickPlaceAction.bind(null, r.id)} defaultEta={r.date ?? ''} label={r.number} />
                      ) : c.key === 'placed' ? (
                        <ArrivedQuick action={quickMoveAction.bind(null, r.id, 'ready', false)} label={r.number} />
                      ) : (
                        <CollectedQuick action={quickMoveAction.bind(null, r.id, 'collected', Boolean(owed))} label={r.number} owed={owed} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="bc-empty">{c.empty}</p>
          )}
          {c.rows.length > 8 ? (
            <Link href={c.href} className="bc-more" scroll={false}>
              See all {c.rows.length}
            </Link>
          ) : null}
        </section>
      ))}
    </div>
  );
}
