import Link from 'next/link';
import { PageHeader } from '@/components/views';
import { parseFilter, WorkList } from '@/components/work-list';
import { requireStaff } from '@/lib/auth';
import { greeting } from '@/lib/format';
import { listWork, metrics } from '@/lib/queries';

type SP = Promise<{ q?: string; filter?: string }>;

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = parseFilter(sp.filter);
  const q = sp.q ?? '';
  const { rows, all } = await listWork(staff.org, { q, filter, scope: 'overview' });
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
      <WorkList base="/" rows={rows} filter={filter} q={q} viewAll />
    </>
  );
}
