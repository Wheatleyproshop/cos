import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/forms';
import { BuildTable } from '@/components/spec-view';
import { MessageBadge } from '@/components/views';
import { PageHeader } from '@/components/views';
import { AddWorkshopItemForm, WorkshopProgressForm } from '@/components/workshop-forms';
import { describeEvent, templateName } from '@/lib/audit';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, stamp, todayInTz } from '@/lib/format';
import { shortDate } from '@/lib/short-date';
import { getJob, jobSpec, WORKSHOP_STATUS_LABELS } from '@/lib/services/workshop';
import { addWorkshopItemAction, deleteJobAction, removeWorkshopItemAction, restoreWorkshopItemAction, workshopProgressAction } from '../../actions';

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).ref) };
}

const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, '')}`;

export default async function WorkshopJobPage({ params }: { params: Promise<{ ref: string }> }) {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const d = await getJob(staff.organisationId, decodeURIComponent((await params).ref));
  if (!d) notFound();
  const { job: j, customer: c, items, deletedItems, events, emails, takenBy } = d;
  const tz = staff.org.timezone;
  const deleted = Boolean(j.archivedAt);
  const open = !deleted && ['checked_in', 'in_progress', 'waiting_parts'].includes(j.status);
  // Clubs can be corrected until the job is collected.
  const editable = open || (!deleted && j.status === 'ready');
  const today = todayInTz(tz);
  const late = open && j.etaDate && j.etaDate < today;
  const spec = jobSpec(j, items);

  return (
    <>
      <PageHeader
        staff={staff}
        title={c.name}
        sub={`${j.reference} · checked in ${stamp(j.createdAt, tz)} by ${takenBy}`}
        actions={
          <Link href="/workshop" className="btn">
            ← Workshop
          </Link>
        }
      />
      {deleted ? (
        <div className="notice warn">
          <b>This job was deleted {stamp(j.archivedAt!, tz)}</b>
          It’s hidden from the workshop list, search and reports, and the customer’s tracking link no longer works.
          {manager ? (
            <div style={{ marginTop: 8 }}>
              <ActionButton action={deleteJobAction.bind(null, j.id, false)} className="btn small">
                Restore job
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="pb-status">
        <span className={`badge ws-${j.status}`}>{WORKSHOP_STATUS_LABELS[j.status]}</span>
        <span className={late ? 'flag' : 'muted'}>
          {j.status === 'ready'
            ? `Ready since ${stamp(j.readyAt!, tz)}`
            : j.status === 'collected'
              ? `Collected ${stamp(j.collectedAt!, tz)}`
              : j.etaDate
                ? `${late ? 'Overdue — was due' : 'Ready by'} ${shortDate(j.etaDate)}`
                : 'No ready date set'}
        </span>
        {j.status === 'waiting_parts' && j.delayReason ? <span className="muted">· {j.delayReason}</span> : null}
      </div>

      <div className="detailgrid">
        <div className="detailbox">
          <small>Customer</small>
          <b>
            <Link href={`/customers/${c.id}`}>{c.name}</Link>
          </b>
          <div className="muted">
            {c.phone ? <a href={tel(c.phone)}>{c.phone}</a> : null}
            {c.phone && c.email ? ' · ' : ''}
            {c.email ? <a href={`mailto:${c.email}?subject=${encodeURIComponent(`Your clubs (${j.reference})`)}`}>{c.email}</a> : null}
          </div>
        </div>
        {j.notes ? (
          <div className="detailbox">
            <small>Internal notes</small>
            <div style={{ whiteSpace: 'pre-line' }}>{j.notes}</div>
          </div>
        ) : null}
      </div>

      <section className="panel">
        <h2>Clubs &amp; work</h2>
        <BuildTable
          build={spec.builds[0]}
          actions={
            editable && items.length > 1 ? (
              <span className="acct-buttons">
                {items.map((i) => (
                  <ActionButton
                    key={i.id}
                    action={removeWorkshopItemAction.bind(null, j.id, i.id)}
                    className="btn small danger"
                    confirm={`Delete ${i.club} (${i.work}) from this job? You can restore it from Deleted clubs.`}
                  >
                    Delete {i.club}
                  </ActionButton>
                ))}
              </span>
            ) : undefined
          }
        />
        {open ? (
          <details className="section">
            <summary>Add a club</summary>
            <AddWorkshopItemForm action={addWorkshopItemAction.bind(null, j.id)} />
          </details>
        ) : null}
        {deletedItems.length ? (
          <details className="section">
            <summary>Deleted clubs ({deletedItems.length})</summary>
            <ul className="attention">
              {deletedItems.map((i) => (
                <li key={i.id}>
                  <span>
                    <b>
                      {i.club}: {i.work}
                    </b>
                    <div className="muted">
                      {[i.parts, i.quantity > 1 ? `× ${i.quantity}` : '', money(i.pricePence)].filter(Boolean).join(' · ')} · deleted {stamp(i.removedAt!, tz)}
                    </div>
                  </span>
                  {editable ? (
                    <ActionButton action={restoreWorkshopItemAction.bind(null, j.id, i.id)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {!deleted && (open || j.status === 'ready' || (j.status === 'collected' && manager)) ? (
        <section className="panel">
          <h2>Update job</h2>
          <WorkshopProgressForm
            action={workshopProgressAction.bind(null, j.id)}
            status={j.status}
            etaDate={j.etaDate}
            delayReason={j.delayReason}
            canSkipEmail={manager}
            canCancel={manager}
          />
        </section>
      ) : null}

      <div className="split">
        <section className="panel">
          <h2>Customer emails</h2>
          {emails.length ? (
            <ul className="attention">
              {emails.map((m) => (
                <li key={m.id}>
                  <span>
                    <Link href={`/emails?view=${m.id}`}>{templateName(m.templateType)}</Link>
                    <div className="muted">
                      {m.recipient} · {stamp(m.createdAt, tz)}
                    </div>
                  </span>
                  <MessageBadge status={m.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No emails yet.</p>
          )}
        </section>
        <section className="panel">
          <h2>History</h2>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                <div>{describeEvent(e)}</div>
                <div className="when">
                  {e.actorLabel} · {stamp(e.createdAt, tz)}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {manager && !deleted ? (
        <div className="actions">
          <ActionButton
            action={deleteJobAction.bind(null, j.id, true)}
            className="btn danger"
            confirm={`Delete ${j.reference} for ${c.name}? Use this for jobs entered by mistake. No email is sent, the tracking link stops working, and you can restore it from Deleted jobs on the Workshop page.`}
          >
            Delete job
          </ActionButton>
        </div>
      ) : null}
    </>
  );
}
