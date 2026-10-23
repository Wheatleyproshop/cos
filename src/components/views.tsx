import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuditEvent } from '@/db/schema';
import type { FormState } from '@/lib/action-utils';
import type { Staff } from '@/lib/auth';
import { describeEvent } from '@/lib/audit';
import { money, niceDate, stamp } from '@/lib/format';
import type { WorkRow } from '@/lib/queries';
import { badgeClass } from '@/lib/status';
import { RowLink } from './chrome';
import { ActionButton } from './forms';
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

type NoteControls = {
  /** Who may delete/restore this note (its author or a manager). */
  canEdit: (note: AuditEvent) => boolean;
  action: (noteEventId: string, deleted: boolean) => () => Promise<FormState>;
};

export function Timeline({ events, tz, notes }: { events: AuditEvent[]; tz: string; notes?: NoteControls }) {
  if (!events.length) return <p className="muted">No activity yet.</p>;
  // Notes are never erased: the latest delete/restore entry for each note decides how it shows.
  const noteState = new Map<string, AuditEvent>();
  for (const e of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const id = (e.metadataJson as { noteEventId?: string } | null)?.noteEventId;
    if (id && (e.eventType === 'note_deleted' || e.eventType === 'note_restored')) noteState.set(id, e);
  }
  return (
    <ol className="timeline" aria-label="Activity timeline">
      {events
        .filter((e) => e.eventType !== 'note_deleted' && e.eventType !== 'note_restored')
        .map((e) => {
          const isNote = e.eventType === 'note_added';
          const del = isNote ? noteState.get(e.id) : undefined;
          const deleted = del?.eventType === 'note_deleted';
          const mine = isNote && notes?.canEdit(e);
          return (
            <li key={e.id} className={`${e.actorType}${deleted ? ' note-deleted' : ''}`}>
              <div>{deleted ? `Note deleted by ${del!.actorLabel} · ${stamp(del!.createdAt, tz)}` : describeEvent(e)}</div>
              <div className="when">
                {stamp(e.createdAt, tz)} — {e.actorLabel}
                {mine ? (
                  <span className="note-btn">
                    {deleted ? (
                      <ActionButton action={notes!.action(e.id, false)} className="linkbtn">
                        Restore
                      </ActionButton>
                    ) : (
                      <ActionButton action={notes!.action(e.id, true)} className="linkbtn danger" confirm="Delete this note? It disappears from the timeline, and you can restore it.">
                        Delete
                      </ActionButton>
                    )}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
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
