import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/views';
import { CheckInForm } from '@/components/workshop-forms';
import { hasRole, requireStaff } from '@/lib/auth';
import { addDays, money, todayInTz } from '@/lib/format';
import { getCustomerDetail } from '@/lib/queries';
import { shortDate } from '@/lib/short-date';
import { listJobs, WORKSHOP_STATUS_LABELS } from '@/lib/services/workshop';
import { checkInAction } from '../actions';

export const metadata: Metadata = { title: 'Workshop' };

const FILTERS = [
  { key: 'open', label: 'In the workshop' },
  { key: 'waiting_parts', label: 'Waiting for parts' },
  { key: 'ready', label: 'Ready to collect' },
  { key: 'collected', label: 'Collected' },
  { key: 'all', label: 'All' },
] as const;
const OPEN = ['checked_in', 'in_progress', 'waiting_parts'];

export default async function WorkshopPage({ searchParams }: { searchParams: Promise<{ filter?: string; customer?: string; checkin?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : 'open';
  const [jobs, cust] = await Promise.all([listJobs(staff.organisationId), sp.customer ? getCustomerDetail(staff.org, sp.customer) : null]);
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
