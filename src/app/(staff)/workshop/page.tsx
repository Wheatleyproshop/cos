import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { CheckInForm } from '@/components/workshop-forms';
import { hasRole, requireStaff } from '@/lib/auth';
import { addDays, money, stamp, todayInTz } from '@/lib/format';
import { getCustomerDetail } from '@/lib/queries';
import { shortDate } from '@/lib/short-date';
import { listDeletedJobs, listJobs, WORKSHOP_STATUS_LABELS } from '@/lib/services/workshop';
import { checkInAction, deleteJobAction, quickJobAction, quickJobPartsAction } from '../actions';
import { PartsQuick, StepQuick } from '@/components/board-actions';

export const metadata: Metadata = { title: 'Workshop' };

const FILTERS = [
  { key: 'open', label: 'In the workshop' },
  { key: 'waiting_parts', label: 'Waiting for parts' },
  { key: 'ready', label: 'Ready to collect' },
  { key: 'collected', label: 'Collected' },
  { key: 'all', label: 'All' },
] as const;
const OPEN = ['checked_in', 'in_progress', 'waiting_parts'];

export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; customer?: string; checkin?: string; moved?: string; to?: string; emailed?: string }>;
}) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : 'open';
  const [jobs, cust, deletedJobs] = await Promise.all([
    listJobs(staff.organisationId),
    sp.customer ? getCustomerDetail(staff.org, sp.customer) : null,
    listDeletedJobs(staff.organisationId),
  ]);
  const manager = hasRole(staff, 'manager');
  const today = todayInTz(staff.org.timezone);
  const open = jobs.filter((j) => OPEN.includes(j.status));
  const overdue = open.filter((j) => j.etaDate && j.etaDate < today);
  const dueToday = open.filter((j) => j.etaDate === today);
  const ready = jobs.filter((j) => j.status === 'ready');
  const rows = jobs.filter((j) => (filter === 'all' ? j.status !== 'cancelled' : filter === 'open' ? OPEN.includes(j.status) : j.status === filter));

  const cards = [
    { key: 'open', label: 'In the workshop', value: open.length, note: `${open.reduce((s, j) => s + j.items, 0)} clubs` },
    { key: 'waiting_parts', label: 'Waiting for parts', value: open.filter((j) => j.status === 'waiting_parts').length, note: 'Customer has been told' },
    { key: 'open', label: 'Due today / overdue', value: dueToday.length + overdue.length, note: `${overdue.length} overdue`, alert: overdue.length > 0 },
    { key: 'ready', label: 'Ready to collect', value: ready.length, note: money(ready.reduce((s, j) => s + j.totalPence, 0)) + ' to take' },
  ];

  return (
    <>
      <PageHeader
        staff={staff}
        title="Workshop."
        sub="Regrips, reshafts, adjustments and repairs — checked in, kept on track and handed back."
        actions={
          <a href="#checkin" className="btn primary">
            ＋ Check in clubs
          </a>
        }
      />
      {sp.moved ? (
        <div className="notice padnotice" role="status">
          <span>
            <Link href={`/workshop/${sp.moved.replace(/[^\w-]/g, '')}`}>
              <b>{sp.moved.replace(/[^\w-]/g, '')}</b>
            </Link>{' '}
            saved — {WORKSHOP_STATUS_LABELS[sp.to as keyof typeof WORKSHOP_STATUS_LABELS]?.toLowerCase() ?? 'updated'}
            {sp.emailed === '1' ? ', and the customer has been emailed' : ''}.
          </span>
          <Link href="/workshop" className="muted" aria-label="Dismiss">
            ✕
          </Link>
        </div>
      ) : null}
      <div className="grid four">
        {cards.map((c) => (
          <Link key={c.label} href={`/workshop?filter=${c.key}`} className={`metric${c.alert ? ' alert' : ''}`} scroll={false}>
            <small>{c.label}</small>
            <strong>{c.value}</strong>
            <em>{c.note}</em>
          </Link>
        ))}
      </div>

      <section className="panel">
        <div className="pills">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/workshop?filter=${f.key}`} className={`pill${filter === f.key ? ' selected' : ''}`} scroll={false}>
              {f.label}
            </Link>
          ))}
        </div>
        {rows.length ? (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Clubs &amp; work</th>
                  <th>Status</th>
                  <th>Ready by</th>
                  <th className="num">Price</th>
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => {
                  const late = OPEN.includes(j.status) && j.etaDate && j.etaDate < today;
                  return (
                    <tr key={j.id}>
                      <td>
                        <Link href={`/workshop/${j.reference}`} className="rowtitle">
                          {j.customerName}
                        </Link>
                        <div className="muted">{j.reference}</div>
                      </td>
                      <td className="ws-summary">{j.summary}</td>
                      <td>
                        <span className={`badge ws-${j.status}`}>{WORKSHOP_STATUS_LABELS[j.status]}</span>
                      </td>
                      <td>
                        {j.etaDate ? <span className={late ? 'flag' : ''}>{late ? `Overdue · ${shortDate(j.etaDate)}` : j.etaDate === today ? 'Today' : shortDate(j.etaDate)}</span> : '—'}
                      </td>
                      <td className="num">{money(j.totalPence)}</td>
                      <td>
                        <div className="ws-next">
                          {j.status === 'checked_in' ? (
                            <StepQuick action={quickJobAction.bind(null, j.id, 'in_progress')} primary>
                              Start ▸
                            </StepQuick>
                          ) : null}
                          {j.status === 'waiting_parts' ? (
                            <StepQuick action={quickJobAction.bind(null, j.id, 'in_progress')} primary>
                              Parts in ▸
                            </StepQuick>
                          ) : null}
                          {OPEN.includes(j.status) ? (
                            <StepQuick
                              action={quickJobAction.bind(null, j.id, 'ready')}
                              primary={j.status === 'in_progress'}
                              confirm={`Mark ${j.reference} ready? ${j.customerName} is emailed to collect.`}
                            >
                              Ready ✓
                            </StepQuick>
                          ) : null}
                          {j.status === 'in_progress' || j.status === 'checked_in' ? (
                            <PartsQuick action={quickJobPartsAction.bind(null, j.id)} label={j.reference} />
                          ) : null}
                          {j.status === 'ready' ? (
                            <StepQuick
                              action={quickJobAction.bind(null, j.id, 'collected')}
                              primary
                              confirm={`Mark ${j.reference} collected?${j.totalPence ? ` Take ${money(j.totalPence)} at the till.` : ''}`}
                            >
                              Collected ✓
                            </StepQuick>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{jobs.length ? 'Nothing here right now.' : 'No workshop jobs yet — check some clubs in below.'}</p>
        )}
      </section>

      {deletedJobs.length ? (
        <section className="panel">
          <details className="section">
            <summary>Deleted jobs ({deletedJobs.length})</summary>
            <ul className="attention">
              {deletedJobs.map((j) => (
                <li key={j.id}>
                  <span>
                    <Link href={`/workshop/${j.reference}`} className="rowtitle">
                      {j.reference} · {j.customerName}
                    </Link>
                    <div className="muted">
                      Was {WORKSHOP_STATUS_LABELS[j.status].toLowerCase()} · deleted {stamp(j.archivedAt!, staff.org.timezone)}
                    </div>
                  </span>
                  {manager ? (
                    <ActionButton action={deleteJobAction.bind(null, j.id, false)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      <section className="panel" id="checkin" style={{ scrollMarginTop: 80 }}>
        <h2>Check in clubs</h2>
        <p className="muted">The customer gets an email listing the clubs, the work, the price and the ready date.</p>
        <CheckInForm
          action={checkInAction}
          defaults={cust ? { customerId: cust.customer.id, customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone } : {}}
          defaultEta={addDays(today, 7)}
          canSkipEmail={hasRole(staff, 'manager')}
        />
      </section>
    </>
  );
}
