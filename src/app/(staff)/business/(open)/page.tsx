import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandDonut } from '@/components/dashboard';
import { PageHeader } from '@/components/views';
import { getPerformance, PERIODS, parsePeriod } from '@/lib/analytics';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { bankSummary } from '@/lib/services/business/bank';
import { spendingInsights } from '@/lib/services/business/insights';
import { commitments, stockReport } from '@/lib/services/business/stock';
import { listPayRuns } from '@/lib/services/business/payroll';
import { listStaff } from '@/lib/services/business/staff';
import { addDaysIso, timeEntriesBetween, workedMinutes } from '@/lib/services/business/time';

export const metadata: Metadata = { title: 'Business' };

const hrs = (m: number) => `${(m / 60).toFixed(1)} h`;

export default async function BusinessOverview({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const staff = await requireBusiness();
  const sp = await searchParams;
  const period = parsePeriod(sp.period ?? '30d');
  const tz = staff.org.timezone;
  const today = todayInTz(tz);
  const perf = await getPerformance(staff.org, period);
  const from = perf.from.toLocaleDateString('en-CA', { timeZone: tz });
  const to = addDaysIso(today, 1);
  const [bank, runs, team, entries, stock, committed, insight] = await Promise.all([
    bankSummary(staff.organisationId, from, to),
    listPayRuns(staff.organisationId),
    listStaff(staff.organisationId),
    timeEntriesBetween(staff.organisationId, from, to, tz),
    stockReport(staff.organisationId),
    commitments(staff.organisationId),
    spendingInsights(staff.organisationId, from, to, Math.max(1, Math.round((perf.period.days ?? 365) / 30))),
  ]);
  const k = perf.kpis;
  const per = perf.period.label.toLowerCase();

  // Wages: pay runs paid in the period; where there are none, an estimate from hours × rates.
  const paid = runs.filter((r) => r.payDate >= from && r.payDate < to);
  const people = team.map((t) => {
    const mins = entries.filter((e) => e.e.userId === t.id && e.e.clockOut).reduce((n, e) => n + workedMinutes(e.e), 0);
    const sales = perf.team.find((r) => r.name === t.name);
    const ws = perf.workshop.byStaff.find((r) => r.name === t.name);
    return {
      id: t.id, name: t.name, job: t.profile?.jobTitle || t.role, mins, orders: sales?.count ?? 0, salesPence: sales?.valuePence ?? 0, workshop: ws?.count ?? 0,
      estPay: t.profile?.payType === 'hourly' ? Math.round((mins / 60) * t.profile.hourlyRatePence) : 0,
    };
  });
  const wages = paid.length ? paid.reduce((n, r) => n + r.employerCost, 0) : people.reduce((n, p) => n + p.estPay, 0);
  const wagesNote = paid.length ? `${paid.length} pay run${paid.length === 1 ? '' : 's'} incl. employer NI & pension` : 'estimate from hours × rates (no pay runs yet)';
  const wagePct = k.valuePence ? Math.round((wages / k.valuePence) * 100) : null;
  const bankIn = bank.months.reduce((n, m) => n + m.inPence, 0);
  const bankOut = bank.months.reduce((n, m) => n + m.outPence, 0);
  const totalMins = people.reduce((n, p) => n + p.mins, 0);

  return (
    <>
      <PageHeader staff={staff} title="How the business is doing." sub={`Sales from COS, money from your bank statements and staff costs — ${per}.`} actions={<span />} />
      <div className="perf-bar">
        <div className="pills">
          {PERIODS.map((p) => (
            <Link key={p.key} href={`/business?period=${p.key}`} className={`pill${p.key === period ? ' selected' : ''}`} scroll={false}>
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid biz-kpis">
        <div className="metric">
          <small>Orders taken (COS)</small>
          <strong className="metric-money">{money(k.valuePence)}</strong>
          <em>
            {k.orders} orders{k.valueChange !== null ? ` · ${k.valueChange >= 0 ? '▲' : '▼'} ${Math.abs(k.valueChange)}% vs previous` : ''}
          </em>
        </div>
        <div className="metric">
          <small>Money in (bank)</small>
          <strong className="metric-money">{bank.months.length ? money(bankIn) : '—'}</strong>
          <em>{bank.months.length ? 'all takings, from your statements' : <Link href="/business/bank">Upload a statement</Link>}</em>
        </div>
        <div className="metric">
          <small>Money out (bank)</small>
          <strong className="metric-money">{bank.months.length ? money(bankOut) : '—'}</strong>
          <em>{bank.months.length ? (bankIn - bankOut >= 0 ? `${money(bankIn - bankOut)} more in than out` : `${money(bankOut - bankIn)} more out than in`) : 'excluding transfers'}</em>
        </div>
        <div className={`metric${wagePct !== null && wagePct > 35 ? ' alert' : ''}`}>
          <small>Staff costs</small>
          <strong className="metric-money">{money(wages)}</strong>
          <em>
            {wagePct !== null ? `${wagePct}% of COS orders · ` : ''}
            {wagesNote}
          </em>
        </div>
        <div className="metric">
          <small>Stock held (cost)</small>
          <strong className="metric-money">{stock.latest ? money(stock.latest.costPence) : '—'}</strong>
          <em>{stock.latest ? `counted ${stock.latest.snap.takenOn}` : <Link href="/business/stock">Upload a stock count</Link>}</em>
        </div>
        <div className="metric">
          <small>Committed (pre-books due)</small>
          <strong className="metric-money">{money(committed.prebookCostPence)}</strong>
          <em>at cost, still to arrive</em>
        </div>
        <div className="metric">
          <small>Hours worked</small>
          <strong className="metric-money">{hrs(totalMins)}</strong>
          <em>{totalMins ? `${money(Math.round(k.valuePence / (totalMins / 60)))} of orders per hour` : 'from the clock-in screen'}</em>
        </div>
      </div>

      {insight.insights.length ? (
        <section className="panel insights">
          <div className="panel-head">
            <h2>What we noticed</h2>
            <Link href="/business/bank" className="muted">
              Bank & spending →
            </Link>
          </div>
          <ul>
            {insight.insights.slice(0, 4).map((i) => (
              <li key={i.title} className={`ins ins-${i.tone}`}>
                <span className="ins-dot" aria-hidden="true">
                  {i.tone === 'good' ? '✓' : i.tone === 'warn' ? '!' : 'i'}
                </span>
                <span>
                  <b>{i.title}</b>
                  <small>{i.detail}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel tablewrap">
        <div className="panel-head">
          <h2>Staff performance</h2>
          <Link href="/business/time" className="muted">
            Hours & rota →
          </Link>
        </div>
        <table className="compact">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Hours</th>
              <th className="num">Orders taken</th>
              <th className="num">Order value</th>
              <th className="num">Value per hour</th>
              <th className="num">Workshop jobs</th>
              <th className="num">Pay (est.)</th>
            </tr>
          </thead>
          <tbody>
            {people
              .filter((p) => p.mins || p.orders || p.workshop)
              .sort((a, b) => b.salesPence - a.salesPence)
              .map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/business/staff/${p.id}`}>{p.name}</Link>
                    <div className="muted">{p.job}</div>
                  </td>
                  <td className="num">{p.mins ? hrs(p.mins) : '—'}</td>
                  <td className="num">{p.orders}</td>
                  <td className="num">{money(p.salesPence)}</td>
                  <td className="num">{p.mins ? money(Math.round(p.salesPence / (p.mins / 60))) : '—'}</td>
                  <td className="num">{p.workshop}</td>
                  <td className="num">{p.estPay ? money(p.estPay) : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          Orders taken through COS only (special orders, fittings and custom work) — not till sales.
        </p>
      </section>

      <div className="perf-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Brand performance</h2>
            <Link href={`/?period=${period}`} className="muted">
              Dashboard →
            </Link>
          </div>
          <div className="dash">
            <BrandDonut rows={perf.brandShare} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Biggest costs</h2>
            <Link href="/business/bank" className="muted">
              Bank →
            </Link>
          </div>
          {bank.categories.filter((c) => c.outPence > 0 && c.category !== 'Transfers between accounts').length ? (
            <ul className="attention">
              {bank.categories
                .filter((c) => c.outPence > 0 && c.category !== 'Transfers between accounts')
                .sort((a, b) => b.outPence - a.outPence)
                .slice(0, 7)
                .map((c) => (
                  <li key={c.category}>
                    <Link href={`/business/bank?category=${encodeURIComponent(c.category)}`}>{c.category}</Link>
                    <b>{money(c.outPence)}</b>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">
              Upload a bank statement on the <Link href="/business/bank">Bank</Link> page to see where the money goes.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
