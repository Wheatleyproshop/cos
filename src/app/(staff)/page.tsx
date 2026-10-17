import Link from 'next/link';
import { PerformanceView } from '@/components/performance';
import { PageHeader } from '@/components/views';
import { parseFilter, WorkList } from '@/components/work-list';
import { hasRole, requireStaff } from '@/lib/auth';
import { greeting, todayInTz } from '@/lib/format';
import { getPerformance, parsePeriod } from '@/lib/analytics';
import { shortDate } from '@/lib/short-date';
import { listWork, metrics } from '@/lib/queries';
import { upcomingLines } from '@/lib/services/prebooks';
import { listJobs } from '@/lib/services/workshop';

type SP = Promise<{ q?: string; filter?: string; view?: string; period?: string }>;

/** Pre-book lines still to arrive that are overdue or due within 30 days, overdue first. */
function prebookArrivals(upcoming: Awaited<ReturnType<typeof upcomingLines>>, tz: string) {
  const today = todayInTz(tz);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  return upcoming
    .map(({ line, prebook }) => {
      const when = line.expectedDate ?? prebook.expectedFrom ?? prebook.expectedTo;
      const by = line.expectedDate ?? prebook.expectedTo ?? prebook.expectedFrom;
      return {
        id: line.id, reference: prebook.reference, brand: prebook.brand, product: line.product, variant: line.variant,
        forCustomer: line.forCustomer, due: line.quantity - line.quantityReceived, when, overdue: Boolean(by && by < today),
      };
    })
    .filter((a): a is typeof a & { when: string } => Boolean(a.when) && (a.overdue || a.when! <= in30))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.when.localeCompare(b.when));
}

function ViewTabs({ view }: { view: 'orders' | 'performance' }) {
  return (
    <div className="seg viewtabs" role="tablist" aria-label="Overview">
      <Link href="/" className={view === 'orders' ? 'on' : ''} role="tab" aria-selected={view === 'orders'} scroll={false}>
        Orders
      </Link>
      <Link href="/?view=performance" className={view === 'performance' ? 'on' : ''} role="tab" aria-selected={view === 'performance'} scroll={false}>
        Performance
      </Link>
    </div>
  );
}

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  if (sp.view === 'performance') {
    const data = await getPerformance(staff.org, parsePeriod(sp.period));
    return (
      <>
        <PageHeader staff={staff} title={greeting(staff.org.timezone)} sub="How the shop is performing, from your own orders." />
        <ViewTabs view="performance" />
        <PerformanceView data={data} canExport={hasRole(staff, 'manager')} />
      </>
    );
  }
  const filter = parseFilter(sp.filter);
  const q = sp.q ?? '';
  const [{ rows, all }, upcoming, jobs] = await Promise.all([
    listWork(staff.org, { q, filter, scope: 'overview' }),
    upcomingLines(staff.organisationId),
    listJobs(staff.organisationId),
  ]);
  const arrivals = prebookArrivals(upcoming, staff.org.timezone);
  const today = todayInTz(staff.org.timezone);
  // Workshop jobs that need someone today: overdue, due today, or waiting on the customer to collect.
  const workshop = jobs
    .filter((j) => (['checked_in', 'in_progress', 'waiting_parts'].includes(j.status) && j.etaDate && j.etaDate <= today) || j.status === 'ready')
    .sort((a, b) => Number(b.status !== 'ready') - Number(a.status !== 'ready') || (a.etaDate ?? '').localeCompare(b.etaDate ?? ''));
  const m = metrics(q ? (await listWork(staff.org, { scope: 'overview' })).all : all);
  const attention = all.filter((r) => r.flags.length).slice(0, 6);

  const cards = [
    { key: 'active', label: 'Active orders', value: m.active, note: 'Currently in progress' },
    { key: 'awaiting', label: 'Awaiting supplier', value: m.awaiting, note: 'Follow up as needed' },
    { key: 'overdue', label: 'Delayed / overdue', value: m.overdue, note: 'ETA passed or delayed', alert: m.overdue > 0 },
    { key: 'ready', label: 'Ready to collect', value: m.ready, note: 'Customer has been notified' },
    { key: 'quote', label: 'Open quotes', value: m.quotes, note: 'Awaiting approval' },
    { key: 'attention', label: 'Needs attention', value: m.attention, note: 'See the list below', alert: m.attention > 0 },
  ];

  return (
    <>
      <PageHeader staff={staff} title={greeting(staff.org.timezone)} sub="Your customer orders, beautifully organised." />
      <ViewTabs view="orders" />
      <div className="grid">
        {cards.map((c) => (
          <Link key={c.key} href={`/?filter=${c.key}`} className={`metric${c.alert ? ' alert' : ''}`} scroll={false}>
            <small>{c.label}</small>
            <strong>{c.value}</strong>
            <em>{c.note}</em>
          </Link>
        ))}
      </div>
      {attention.length && filter === 'all' && !q ? (
        <section className="panel" style={{ marginBottom: 22 }} aria-labelledby="attn">
          <div className="panel-head">
            <h2 id="attn">Requires attention</h2>
            <Link href="/?filter=attention" className="muted">
              See all {m.attention}
            </Link>
          </div>
          <ul className="attention">
            {attention.map((r) => (
              <li key={r.id}>
                <span>
                  <Link href={r.kind === 'order' ? `/orders/${r.number}` : `/quotes/${r.number}`} className="rowtitle" scroll={false}>
                    {r.number} · {r.customerName}
                  </Link>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {r.brand} {r.product}
                  </span>
                </span>
                <span>
                  {r.flags.map((f) => (
                    <span key={f.code} className="flag">
                      {f.label}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {workshop.length && filter === 'all' && !q ? (
        <section className="panel" style={{ marginBottom: 22 }} aria-labelledby="workshop">
          <div className="panel-head">
            <h2 id="workshop">Workshop</h2>
            <Link href="/workshop" className="muted">
              All workshop jobs
            </Link>
          </div>
          <ul className="attention">
            {workshop.slice(0, 8).map((j) => {
              const late = j.status !== 'ready' && j.etaDate && j.etaDate < today;
              return (
                <li key={j.id}>
                  <span>
                    <Link href={`/workshop/${j.reference}`} className="rowtitle" scroll={false}>
                      {j.reference} · {j.customerName}
                    </Link>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {j.summary}
                    </span>
                  </span>
                  <span className={j.status === 'ready' ? 'muted' : late ? 'flag' : 'muted'}>
                    {j.status === 'ready' ? 'Ready to collect' : late ? `Overdue · was due ${shortDate(j.etaDate!)}` : 'Due today'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {arrivals.length && filter === 'all' && !q ? (
        <section className="panel" style={{ marginBottom: 22 }} aria-labelledby="arrivals">
          <div className="panel-head">
            <h2 id="arrivals">Pre-book arrivals</h2>
            <Link href="/prebook" className="muted">
              All pre-books
            </Link>
          </div>
          <ul className="attention">
            {arrivals.slice(0, 8).map((a) => (
              <li key={a.id}>
                <span>
                  <Link href={`/prebook/${a.reference}`} className="rowtitle" scroll={false}>
                    {a.brand} · {a.product}
                  </Link>
                  {a.variant ? (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {a.variant}
                    </span>
                  ) : null}
                  {a.forCustomer ? (
                    <span className="pb-for" style={{ marginLeft: 8 }}>
                      For: {a.forCustomer}
                    </span>
                  ) : null}
                </span>
                <span>
                  <span className={a.overdue ? 'flag' : 'muted'}>
                    {a.due} due · {a.overdue ? `overdue since ${shortDate(a.when)}` : shortDate(a.when)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {arrivals.length > 8 ? (
            <p className="muted" style={{ marginTop: 8 }}>
              and {arrivals.length - 8} more on the <Link href="/prebook">Pre-book page</Link>.
            </p>
          ) : null}
        </section>
      ) : null}
      <WorkList base="/" rows={rows} filter={filter} q={q} viewAll />
    </>
  );
}
