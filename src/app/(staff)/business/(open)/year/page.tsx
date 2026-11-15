import type { Metadata } from 'next';
import Link from 'next/link';
import { HistoryUploadForm } from '@/components/business-ui';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { todayInTz } from '@/lib/format';
import { financeSettings } from '@/lib/services/business/tax';
import { historySummary, yearAtAGlance } from '@/lib/services/business/year';
import { uploadHistoryAction } from '../../actions';

export const metadata: Metadata = { title: 'Year at a glance · Business' };

const pounds = (p: number | null) => (p === null ? '—' : `£${Math.round(p / 100).toLocaleString('en-GB')}`);
const k = (p: number | null) => (p === null ? '—' : p >= 100_000_00 ? `£${(p / 100_000_00).toFixed(1)}m` : p >= 1_000_00 ? `£${(p / 1_000_00).toFixed(p >= 10_000_00 ? 0 : 1)}k` : `£${Math.round(p / 100)}`);

function Change({ c, invert }: { c: number | null; invert?: boolean }) {
  if (c === null) return null;
  const good = invert ? c < 0 : c > 0;
  return (
    <span className={`yoy ${c === 0 ? '' : good ? 'up' : 'down'}`}>
      {c > 0 ? '▲' : c < 0 ? '▼' : '•'} {Math.abs(c)}%
    </span>
  );
}

const ROWS = [
  { key: 'sales', label: 'Sales', invert: false },
  { key: 'moneyIn', label: 'Money in', invert: false },
  { key: 'moneyOut', label: 'Money out', invert: true },
  { key: 'stock', label: 'Stock bought', invert: true },
  { key: 'wages', label: 'Wages', invert: true },
  { key: 'running', label: 'Running costs', invert: true },
] as const;

export default async function YearPage({ searchParams }: { searchParams: Promise<{ y?: string }> }) {
  const staff = await requireBusiness();
  const sp = await searchParams;
  const offset = Math.max(-5, Math.min(0, Number(sp.y ?? 0) || 0));
  const today = todayInTz(staff.org.timezone);
  const fin = financeSettings(staff.org.finance);
  const [y, hist] = await Promise.all([yearAtAGlance(staff.organisationId, fin, today, offset), historySummary(staff.organisationId)]);
  const salesMax = Math.max(1, ...y.months.flatMap((m) => [m.sales.now ?? 0, m.sales.prev ?? 0]));
  const thisYear = Number(today.slice(0, 4));
  const hasPrevSales = y.months.some((m) => m.sales.prev !== null);
  return (
    <>
      <PageHeader staff={staff} title="Year at a glance." sub={`${y.label}, month by month, against ${y.prevLabel}.`} actions={<span />} />
      <div className="perf-bar">
        <div className="pills">
          {[0, -1, -2].map((o) => (
            <Link key={o} href={`/business/year?y=${o}`} className={`pill${o === offset ? ' selected' : ''}`} scroll={false}>
              {o === 0 ? 'This year' : o === -1 ? 'Last year' : '2 years ago'}
            </Link>
          ))}
        </div>
        <span className="muted small">Company year ends {new Date(Date.UTC(2000, fin.yearEndMonth - 1, 15)).toLocaleDateString('en-GB', { month: 'long' })} · change in Adviser → Tax settings</span>
      </div>

      <div className="grid biz-kpis">
        {ROWS.map((r) => {
          const t = y.ytd[r.key];
          return (
            <div key={r.key} className="metric">
              <small>{r.label} · year so far</small>
              <strong className="metric-money">{t.now ? pounds(t.now) : '—'}</strong>
              <em>
                {t.change !== null ? (
                  <>
                    <Change c={t.change} invert={r.invert} /> vs same {t.compareMonths} month{t.compareMonths === 1 ? '' : 's'} last year
                  </>
                ) : (
                  'no figures for last year yet'
                )}
              </em>
            </div>
          );
        })}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Sales by month</h2>
          <span className="muted">
            <i className="key-now" /> This year <i className="key-prev" /> Last year
          </span>
        </div>
        <div className="yoy-chart" role="img" aria-label="Sales by month, this year against last year">
          {y.months.map((m) => (
            <div key={m.month} className={`yoy-col${m.future ? ' future' : ''}`} title={`${m.label}: ${pounds(m.sales.now)} this year, ${pounds(m.sales.prev)} last year`}>
              <div className="yoy-bars">
                <span className="bar-prev" style={{ height: `${((m.sales.prev ?? 0) / salesMax) * 100}%` }} />
                <span className={`bar-now${m.salesSource === 'partial' ? ' partial' : ''}`} style={{ height: `${((m.sales.now ?? 0) / salesMax) * 100}%` }} />
              </div>
              <small>{m.label}</small>
            </div>
          ))}
        </div>
        {!hasPrevSales ? (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Upload last year’s Shopify sales report below to see last year’s bars. Striped bars are months COS only has part of.
          </p>
        ) : null}
      </section>

      <section className="panel tablewrap" style={{ marginTop: 18 }}>
        <h2>Month by month</h2>
        <table className="compact yoy-table">
          <thead>
            <tr>
              <th>Month</th>
              {ROWS.map((r) => (
                <th key={r.key} className="num">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {y.months.map((m) => (
              <tr key={m.month} className={m.future ? 'future' : ''}>
                <td>
                  <b>{m.label}</b>
                </td>
                {ROWS.map((r) => {
                  const c = m[r.key];
                  return (
                    <td key={r.key} className="num">
                      {k(c.now)}
                      {r.key === 'sales' && m.salesSource === 'partial' ? <span className="muted small"> part</span> : null}
                      {c.prev !== null ? (
                        <div className="muted small">
                          LY {k(c.prev)} <Change c={c.change} invert={r.invert} />
                        </div>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Sales as Shopify reports them (including VAT, after discounts — store credit counted as a discount here so years compare like for like). Money in and out
          from bank statements, leaving out transfers between your own accounts. Wages from pay runs, or the bank if there are none.
        </p>
      </section>

      <section className="panel tablewrap" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>Brands, this year against last</h2>
          <span className="muted small">
            {y.brands.thisSource === 'shopify' && y.brands.liveFrom ? `this year from Shopify since ${y.brands.liveFrom}` : ''}
          </span>
        </div>
        {y.brands.rows.length ? (
          <table className="compact">
            <thead>
              <tr>
                <th>Brand</th>
                <th className="num">This year</th>
                <th className="num">Last year</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {y.brands.rows.map((b) => (
                <tr key={b.name}>
                  <td>
                    <b>{b.name}</b>
                  </td>
                  <td className="num">{pounds(b.now)}</td>
                  <td className="num">{b.prev === null ? '—' : pounds(b.prev)}</td>
                  <td className="num">{b.prev ? <Change c={Math.round(((b.now - b.prev) / b.prev) * 100)} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No brand sales yet.</p>
        )}
        {y.brands.lastSource === 'none' ? (
          <p className="muted small" style={{ marginBottom: 0 }}>
            For last year’s column, upload Shopify’s “Sales by product vendor” report for last year below. For a fair comparison, upload the same report for this
            year too — COS only has recent sales from Shopify directly.
          </p>
        ) : null}
      </section>

      <div className="split" style={{ marginTop: 18 }}>
        <section className="panel">
          <h2>Add previous years</h2>
          <ol className="steps-list">
            <li>
              <b>Sales:</b> Shopify → Analytics → Reports → <b>Sales over time</b>. Set the dates to a whole year, group by <b>Month</b>, then Export → CSV.
            </li>
            <li>
              <b>Brands:</b> the same for <b>Sales by product vendor</b> (and <b>Sales by product type</b> for categories). If the report has no month column,
              pick the year below.
            </li>
            <li>
              <b>Bank:</b> upload older statements on the <Link href="/business/bank">Bank</Link> page — overlaps are skipped automatically.
            </li>
          </ol>
          <HistoryUploadForm action={uploadHistoryAction} years={[thisYear, thisYear - 1, thisYear - 2, thisYear - 3]} />
        </section>
        <section className="panel">
          <h2>History uploaded</h2>
          {hist.length ? (
            <ul className="attention">
              {hist.map((h) => (
                <li key={h.dimension}>
                  <span>
                    <b>{h.dimension === 'total' ? 'Monthly sales' : h.dimension === 'brand' ? 'Sales by brand' : 'Sales by product type'}</b>
                    <div className="muted">
                      {h.from.slice(0, 7)} to {h.to.slice(0, 7)} · {h.n} rows
                    </div>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
