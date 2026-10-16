import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuditEvent } from '@/db/schema';
import type { Staff } from '@/lib/auth';
import { describeEvent } from '@/lib/audit';
import { money, niceDate, stamp } from '@/lib/format';
import type { WorkRow } from '@/lib/queries';
import { badgeClass } from '@/lib/status';
import { RowLink } from './chrome';
import { NotificationBell } from './notifications';
import { RefreshButton } from './refresh-button';

export function PageHeader({ staff, title, sub, actions }: { staff: Staff; title: string; sub: string; actions?: ReactNode }) {
  return (
    <div className="top">
      <div>
        <div className="eyebrow">{staff.org.storeName.toUpperCase()} / ORDER MANAGEMENT</div>
        <h1>{title}</h1>
        <div className="lede">{sub}</div>
      </div>
      <div className="top-actions">
        <RefreshButton />
        <NotificationBell />
        {actions ?? (
          <Link href="/orders/new" className="btn primary" scroll={false}>
            ＋ &nbsp; New order
          </Link>
        )}
      </div>
    </div>
  );
}

export function Badge({ status, text }: { status: WorkRow['status']; text: string }) {
  return <span className={badgeClass(status)}>{text}</span>;
}

export function MessageBadge({ status, simulated }: { status: string; simulated?: boolean }) {
  const cls = status === 'delivered' || status === 'sent' ? 'badge ready' : status === 'failed' || status === 'bounced' ? 'badge failed' : 'badge';
  return (
    <span className={cls}>
      {status}
      {simulated && status !== 'suppressed' ? ' (simulated)' : ''}
    </span>
  );
}

export function WorkTable({ rows, empty }: { rows: WorkRow[]; empty: ReactNode }) {
  return (
    <div className="panel tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Order / Product</th>
            <th scope="col">Customer</th>
            <th scope="col">Price</th>
            <th scope="col">ETA</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => {
              const href = r.kind === 'order' ? `/orders/${r.number}` : `/quotes/${r.number}`;
              return (
                <RowLink key={r.id} href={href}>
                  <td>
                    <Link href={href} className="rowtitle" scroll={false}>
                      {r.brand} {r.product}
                    </Link>
                    <div className="muted">
                      {r.number}
                      {r.sku ? ` · ${r.sku}` : ''}
                      {r.supplierReference ? ` · Supplier ${r.supplierReference}` : ''}
                    </div>
                    {r.flags.map((f) => (
                      <span key={f.code} className="flag">
                        {f.label}
                      </span>
                    ))}
                  </td>
                  <td>
                    {r.customerName}
                    <div className="muted">{r.customerEmail}</div>
                  </td>
                  <td>
                    <b>{money(r.totalPence)}</b>
                  </td>
                  <td>{r.kind === 'quote' ? (r.date ? `Valid to ${niceDate(r.date)}` : '—') : niceDate(r.date)}</td>
                  <td>
                    <Badge status={r.status} text={r.statusText} />
                    {r.archived ? <div className="muted">Archived</div> : null}
                  </td>
                  <td>
                    <Link href={href} className="arrow" aria-label={`Open ${r.number}`} scroll={false}>
                      →
                    </Link>
                  </td>
                </RowLink>
              );
            })
          ) : (
            <tr>
              <td colSpan={6} className="empty">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Timeline({ events, tz }: { events: AuditEvent[]; tz: string }) {
  if (!events.length) return <p className="muted">No activity yet.</p>;
  return (
    <ol className="timeline" aria-label="Activity timeline">
      {events.map((e) => (
        <li key={e.id} className={e.actorType}>
          <div>{describeEvent(e)}</div>
          <div className="when">
            {stamp(e.createdAt, tz)} — {e.actorLabel}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DetailBox({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="detailbox">
      <small>{label}</small>
      <b>{children}</b>
      {sub ? <div className="muted">{sub}</div> : null}
    </div>
  );
}
