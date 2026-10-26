import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { PrebookDetailsForm } from '@/components/prebook-forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, stamp, todayInTz } from '@/lib/format';
import { listAccounts } from '@/lib/services/accounts';
import { listDeletedPrebooks, listPrebooks, PREBOOK_STATUS_LABELS, upcomingLines } from '@/lib/services/prebooks';
import { createPrebookAction, deletePrebookAction, prebookStatusAction, receiveAllPrebookAction } from '../actions';
import { StepQuick } from '@/components/board-actions';

export const metadata: Metadata = { title: 'Pre-book' };

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'draft', label: 'Drafts' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
] as const;

const day = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const deliveryWindow = (from: string | null, to: string | null) => (from && to ? `${day(from)} – ${day(to)}` : from ? `From ${day(from)}` : to ? `By ${day(to)}` : 'Not set');

export default async function PrebookPage({ searchParams }: { searchParams: Promise<{ filter?: string; brand?: string; season?: string }> }) {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : 'open';
  const [all, accounts, upcoming, deleted] = await Promise.all([
    listPrebooks(staff.organisationId),
    listAccounts(staff.organisationId),
    upcomingLines(staff.organisationId),
    listDeletedPrebooks(staff.organisationId),
  ]);
  const today = todayInTz(staff.org.timezone);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const open = all.filter((p) => !['delivered', 'cancelled', 'draft'].includes(p.status));
  const outstanding = open.reduce((s, p) => s + (p.valuePence - p.receivedValuePence), 0);
  const arrivingSoon = upcoming.filter(({ line, prebook }) => {
    const when = line.expectedDate ?? prebook.expectedFrom;
    return when && when <= in30;
  });
  const overdue = upcoming.filter(({ line, prebook }) => {
    const by = line.expectedDate ?? prebook.expectedTo ?? prebook.expectedFrom;
    return by && by < today;
  });

  // Arrivals by month (outstanding quantity and value), from each line's date or the pre-book window.
  const months = new Map<string, { qty: number; value: number }>();
  for (const { line, prebook } of upcoming) {
    const when = line.expectedDate ?? prebook.expectedFrom ?? prebook.expectedTo;
    const key = when ? when.slice(0, 7) : 'unscheduled';
    const left = line.quantity - line.quantityReceived;
    const m = months.get(key) ?? { qty: 0, value: 0 };
    m.qty += left;
    m.value += left * line.unitCostPence;
    months.set(key, m);
  }
  const monthRows = [...months.entries()].sort(([a], [b]) => (a === 'unscheduled' ? 1 : b === 'unscheduled' ? -1 : a.localeCompare(b)));
  const maxMonth = Math.max(1, ...monthRows.map(([, m]) => m.value));

  let rows = all.filter((p) =>
    filter === 'all' ? true : filter === 'open' ? !['delivered', 'cancelled'].includes(p.status) : p.status === filter,
  );
  if (sp.brand) rows = rows.filter((p) => p.brand.toLowerCase() === sp.brand!.toLowerCase());
  if (sp.season) rows = rows.filter((p) => p.season === sp.season);
  const seasons = [...new Set(all.map((p) => p.season).filter(Boolean))].sort().reverse();

  const cards = [
    { label: 'Open pre-books', value: String(open.length), note: `${all.filter((p) => p.status === 'draft').length} draft${all.filter((p) => p.status === 'draft').length === 1 ? '' : 's'} not yet placed` },
    { label: 'Still to arrive', value: money(outstanding), note: `${upcoming.reduce((s, u) => s + u.line.quantity - u.line.quantityReceived, 0)} items at cost` },
    { label: 'Arriving in 30 days', value: String(arrivingSoon.reduce((s, u) => s + u.line.quantity - u.line.quantityReceived, 0)), note: 'items due' },
    { label: 'Overdue', value: String(overdue.length), note: 'lines past their date', alert: overdue.length > 0 },
  ];

  return (
    <>
      <PageHeader staff={staff} title="Pre-book." sub="Seasonal stock ordered with your brands, and when it’s due in." actions={<span />} />

      <div className="grid four">
        {cards.map((c) => (
          <div key={c.label} className={`metric${c.alert ? ' alert' : ''}`}>
            <small>{c.label}</small>
            <strong className="metric-money">{c.value}</strong>
            <em>{c.note}</em>
          </div>
        ))}
      </div>

      {monthRows.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Arrivals by month</h2>
            <span className="muted">Outstanding stock at cost</span>
          </div>
          <ol className="rankbars">
            {monthRows.map(([key, m]) => (
              <li key={key}>
                <div className="rb-top">
                  <span>
                    {key === 'unscheduled'
                      ? 'No date yet'
                      : new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
                  </span>
                  <b>{money(m.value)}</b>
                </div>
                <div className="rb-track">
                  <div className="rb-fill" style={{ width: `${Math.max(3, (m.value / maxMonth) * 100)}%` }} />
                </div>
                <small>{m.qty} items</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {arrivingSoon.length ? (
        <section className="panel">
          <h2>Arriving in the next 30 days</h2>
          <ul className="attention">
            {arrivingSoon.slice(0, 12).map(({ line, prebook }) => (
              <li key={line.id}>
                <span>
                  <Link href={`/prebook/${prebook.reference}`} className="rowtitle">
                    {prebook.brand} · {line.product}
                  </Link>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {line.variant}
                  </span>
                  {line.forCustomer ? <span className="pb-for" style={{ marginLeft: 8 }}>For: {line.forCustomer}</span> : null}
                </span>
                <span className="muted">
                  {line.quantity - line.quantityReceived} due · {day(line.expectedDate ?? prebook.expectedFrom)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Pre-books</h2>
        </div>
        <div className="pills">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/prebook?filter=${f.key}${sp.season ? `&season=${encodeURIComponent(sp.season)}` : ''}`} className={`pill${filter === f.key ? ' selected' : ''}`}>
              {f.label}
            </Link>
          ))}
          {seasons.map((s) => (
            <Link key={s} href={`/prebook?filter=${filter}&season=${encodeURIComponent(s)}`} className={`pill${sp.season === s ? ' selected' : ''}`}>
              {s}
            </Link>
          ))}
          {sp.brand || sp.season ? (
            <Link href={`/prebook?filter=${filter}`} className="pill">
              Clear {sp.brand ? sp.brand : ''} ×
            </Link>
          ) : null}
        </div>
        {rows.length ? (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Pre-book</th>
                  <th>Status</th>
                  <th>Delivery</th>
                  <th className="num">Received</th>
                  <th className="num">Value (cost)</th>
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/prebook/${p.reference}`} className="rowtitle">
                        {p.brand} {p.season}
                      </Link>
                      <div className="muted">
                        {p.reference}
                        {p.title ? ` · ${p.title}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className={`badge pb-${p.status}`}>{PREBOOK_STATUS_LABELS[p.status]}</span>
                    </td>
                    <td>{deliveryWindow(p.expectedFrom, p.expectedTo)}</td>
                    <td className="num">
                      {p.received} / {p.quantity}
                    </td>
                    <td className="num">{money(p.valuePence)}</td>
                    <td>
                      <div className="ws-next">
                        {manager && p.status === 'draft' ? (
                          <StepQuick
                            action={prebookStatusAction.bind(null, p.id, 'placed')}
                            primary
                            confirm={`Mark ${p.reference} (${p.brand}) as placed with the brand?`}
                          >
                            Placed ▸
                          </StepQuick>
                        ) : null}
                        {manager && p.status === 'placed' ? (
                          <StepQuick action={prebookStatusAction.bind(null, p.id, 'confirmed')} primary>
                            Confirmed ✓
                          </StepQuick>
                        ) : null}
                        {['placed', 'confirmed', 'part_delivered'].includes(p.status) && p.quantity > p.received ? (
                          <>
                            <StepQuick
                              action={receiveAllPrebookAction.bind(null, p.id)}
                              primary={p.status !== 'placed'}
                              confirm={`Book in everything still due on ${p.reference}: ${p.quantity - p.received} item${p.quantity - p.received === 1 ? '' : 's'}?`}
                            >
                              All arrived ✓
                            </StepQuick>
                            <Link href={`/prebook/${p.reference}#receive`} className="btn small">
                              Part delivery…
                            </Link>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{all.length ? 'Nothing matches this filter.' : 'No pre-books yet.'}</p>
        )}
      </section>

      {deleted.length ? (
        <section className="panel">
          <details className="section">
            <summary>Deleted pre-books ({deleted.length})</summary>
            <ul className="attention">
              {deleted.map((p) => (
                <li key={p.id}>
                  <span>
                    <Link href={`/prebook/${p.reference}`} className="rowtitle">
                      {p.reference} · {p.brand} {p.season}
                    </Link>
                    <div className="muted">
                      {p.title ? `${p.title} · ` : ''}deleted {stamp(p.removedAt!, staff.org.timezone)}
                    </div>
                  </span>
                  {manager ? (
                    <ActionButton action={deletePrebookAction.bind(null, p.id, false)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      {manager ? (
        <section className="panel">
          <details className="section" open={!all.length}>
            <summary>New pre-book</summary>
            <PrebookDetailsForm
              action={createPrebookAction}
              accounts={accounts.map((a) => ({ value: a.id, label: a.accountNumber ? `${a.brand} (${a.accountNumber})` : a.brand }))}
              values={sp.brand ? { supplierAccountId: accounts.find((a) => a.brand.toLowerCase() === sp.brand!.toLowerCase())?.id } : {}}
              submitLabel="Create pre-book"
            />
          </details>
        </section>
      ) : null}
    </>
  );
}
