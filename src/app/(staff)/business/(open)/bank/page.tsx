import type { Metadata } from 'next';
import Link from 'next/link';
import { CategoryPicker, StatementUploadForm } from '@/components/business-ui';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { BANK_CATEGORIES } from '@/lib/bank-csv';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { bankPeriods, bankSummary, compareBank, listStatements, listTransactions } from '@/lib/services/business/bank';
import { spendingInsights } from '@/lib/services/business/insights';
import { removeStatementAction, setCategoryAction, uploadStatementAction } from '../../actions';

export const metadata: Metadata = { title: 'Bank · Business' };

const RANGES = [
  { key: '1', label: 'This month' },
  { key: '3', label: '3 months' },
  { key: '6', label: '6 months' },
  { key: '12', label: '12 months' },
];
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

const nextMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

/** "2026-10" (a month) or "2026" (a year) → [from, to) and a label. */
function periodOf(p: string) {
  if (/^\d{4}$/.test(p)) return { from: `${p}-01-01`, to: `${Number(p) + 1}-01-01`, label: p };
  return { from: `${p}-01`, to: nextMonth(p), label: monthName(p) };
}

function Compare({ c, aLabel, bLabel }: { c: Awaited<ReturnType<typeof compareBank>>; aLabel: string; bLabel: string }) {
  const ch = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
  const Chg = ({ a, b, invert }: { a: number; b: number; invert?: boolean }) => {
    const v = ch(a, b);
    if (v === null) return <span className="muted">—</span>;
    const good = invert ? v < 0 : v > 0;
    return <span className={`yoy ${v === 0 ? '' : good ? 'up' : 'down'}`}>{v > 0 ? '▲' : v < 0 ? '▼' : '•'} {Math.abs(v)}%</span>;
  };
  return (
    <>
      <div className="grid biz-kpis">
        <div className="metric">
          <small>Money in · {aLabel}</small>
          <strong className="metric-money">{money(c.a.in)}</strong>
          <em>
            {money(c.b.in)} in {bLabel} <Chg a={c.a.in} b={c.b.in} />
          </em>
        </div>
        <div className="metric">
          <small>Money out · {aLabel}</small>
          <strong className="metric-money">{money(c.a.out)}</strong>
          <em>
            {money(c.b.out)} in {bLabel} <Chg a={c.a.out} b={c.b.out} invert />
          </em>
        </div>
        <div className="metric">
          <small>Difference · {aLabel}</small>
          <strong className="metric-money">{money(c.a.in - c.a.out)}</strong>
          <em>{money(c.b.in - c.b.out)} in {bLabel}</em>
        </div>
      </div>
      {!c.bHasData ? <p className="muted small">No bank statements cover {bLabel} yet — upload them below to compare.</p> : null}
      <div className="tablewrap">
        <table className="compact yoy-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">{aLabel}</th>
              <th className="num">{bLabel}</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => {
              const income = r.aIn + r.bIn > r.aOut + r.bOut;
              const a = income ? r.aIn : r.aOut;
              const b = income ? r.bIn : r.bOut;
              return (
                <tr key={r.category}>
                  <td>
                    <b>{r.category}</b> <span className="muted small">{income ? 'in' : 'out'}</span>
                  </td>
                  <td className="num">{money(a)}</td>
                  <td className="num">{money(b)}</td>
                  <td className="num">
                    <Chg a={a} b={b} invert={!income} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default async function BankPage({ searchParams }: { searchParams: Promise<{ months?: string; category?: string; q?: string; period?: string; vs?: string }> }) {
  const staff = await requireBusiness();
  const sp = await searchParams;
  const months = RANGES.some((r) => r.key === sp.months) ? Number(sp.months) : 6;
  const today = todayInTz(staff.org.timezone);
  const [y, m] = today.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - months, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const category = sp.category && (BANK_CATEGORIES as readonly string[]).includes(sp.category) ? sp.category : undefined;
  const periods = await bankPeriods(staff.organisationId);
  const period = sp.period && (periods.months.includes(sp.period) || periods.years.includes(sp.period)) ? sp.period : null;
  const isYear = period ? /^\d{4}$/.test(period) : false;
  const vs = sp.vs === 'prev' && !isYear ? 'prev' : 'lastyear';
  const aP = period ? periodOf(period) : null;
  const bP = period ? periodOf(isYear ? String(Number(period) - 1) : vs === 'prev' ? prevMonth(period) : `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`) : null;
  const [summary, statements, txs, insight, comparison] = await Promise.all([
    bankSummary(staff.organisationId, from, to),
    listStatements(staff.organisationId),
    listTransactions(staff.organisationId, { from, to, category, q: sp.q?.slice(0, 60) }),
    spendingInsights(staff.organisationId, from, to, months),
    aP && bP ? compareBank(staff.organisationId, aP, bP) : Promise.resolve(null),
  ]);
  const uncategorised = txs.filter(({ t }) => t.category === 'Other spending' || t.category === 'Uncategorised' || t.category === 'Other income').length;
  const totalIn = summary.months.reduce((n, x) => n + x.inPence, 0);
  const totalOut = summary.months.reduce((n, x) => n + x.outPence, 0);
  const maxMonth = Math.max(1, ...summary.months.flatMap((x) => [x.inPence, x.outPence]));
  const spending = summary.categories.filter((c) => c.outPence > 0 && c.category !== 'Transfers between accounts').sort((a, b) => b.outPence - a.outPence);
  const maxCat = Math.max(1, ...spending.map((c) => c.outPence));
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { months: String(months), category, q: sp.q, ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/business/bank?${p}`;
  };
  return (
    <>
      <PageHeader staff={staff} title="Bank." sub="Upload statements to see where money comes from and goes — every transaction sorted into a category." actions={<span />} />
      <div className="perf-bar">
        <div className="pills">
          {RANGES.map((r) => (
            <Link key={r.key} href={qs({ months: r.key })} className={`pill${String(months) === r.key ? ' selected' : ''}`} scroll={false}>
              {r.label}
            </Link>
          ))}
        </div>
      </div>

      {periods.months.length ? (
        <section className="panel compare-panel" id="compare">
          <div className="panel-head">
            <h2>Compare</h2>
            <span className="muted small">any month or year against the month before, or the same time last year</span>
          </div>
          <form action="/business/bank#compare" className="compare-form">
            <label className="field">
              <span>Period</span>
              <select name="period" defaultValue={period ?? ''}>
                <option value="">Choose…</option>
                <optgroup label="Years">
                  {periods.years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Months">
                  {periods.months.map((m) => (
                    <option key={m} value={m}>
                      {monthName(m)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="field">
              <span>Compared with</span>
              <select name="vs" defaultValue={vs}>
                <option value="lastyear">Same time last year</option>
                <option value="prev">The month before (months only)</option>
              </select>
            </label>
            <button type="submit" className="btn">
              Compare
            </button>
          </form>
          {comparison && aP && bP ? <Compare c={comparison} aLabel={aP.label} bLabel={bP.label} /> : null}
        </section>
      ) : null}

      {statements.length ? (
        <>
          <div className="grid biz-kpis">
            <div className="metric">
              <small>Money in</small>
              <strong className="metric-money">{money(totalIn)}</strong>
              <em>excluding transfers between accounts</em>
            </div>
            <div className="metric">
              <small>Money out</small>
              <strong className="metric-money">{money(totalOut)}</strong>
            </div>
            <div className={`metric${totalIn - totalOut < 0 ? ' alert' : ''}`}>
              <small>Difference</small>
              <strong className="metric-money">{money(totalIn - totalOut)}</strong>
              <em>{totalIn - totalOut >= 0 ? 'more in than out' : 'more out than in'}</em>
            </div>
          </div>
          {insight.insights.length ? (
            <section className="panel insights" aria-labelledby="noticed">
              <h2 id="noticed">What we noticed</h2>
              <ul>
                {insight.insights.map((i) => (
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
              <p className="muted ins-note">Rules of thumb from your own statements — not accounting advice. Your accountant can tell you what’s right for the shop.</p>
            </section>
          ) : null}
          <div className="perf-grid">
            <section className="panel">
              <div className="panel-head">
                <h2>In and out by month</h2>
                <span className="muted">
                  <i className="key-in" /> In <i className="key-out" /> Out
                </span>
              </div>
              {summary.months.length ? (
                <div className="inout">
                  {summary.months.map((x) => (
                    <div key={x.month} className="inout-col" title={`${monthLabel(x.month)}: in ${money(x.inPence)}, out ${money(x.outPence)}`}>
                      <div className="inout-bars">
                        <span className="bar-in" style={{ height: `${(x.inPence / maxMonth) * 100}%` }} />
                        <span className="bar-out" style={{ height: `${(x.outPence / maxMonth) * 100}%` }} />
                      </div>
                      <small>{monthLabel(x.month)}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No transactions in this period.</p>
              )}
            </section>
            <section className="panel">
              <h2>Where the money goes</h2>
              {spending.length ? (
                <ol className="rankbars">
                  {spending.slice(0, 10).map((c) => (
                    <li key={c.category}>
                      <div className="rb-top">
                        <Link href={`${qs({ category: c.category })}#transactions`}>{c.category}</Link>
                        <b>{money(c.outPence)}</b>
                      </div>
                      <div className="rb-track">
                        <div className="rb-fill" style={{ width: `${Math.max(3, (c.outPence / maxCat) * 100)}%` }} />
                      </div>
                      <small>
                        {c.count} transaction{c.count === 1 ? '' : 's'} · {totalOut ? Math.round((c.outPence / totalOut) * 100) : 0}% of spending
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No spending in this period.</p>
              )}
            </section>
          </div>

          <div className="perf-grid">
            <section className="panel">
              <h2>Regular payments</h2>
              {insight.recurring.length ? (
                <ul className="attention">
                  {insight.recurring.slice(0, 15).map((r) => (
                    <li key={r.name}>
                      <span>
                        <b>{r.name}</b>
                        <div className="muted">
                          {r.category} · seen in {r.months} of the last 6 months · last {r.last}
                        </div>
                      </span>
                      <span className="num">
                        <b>{money(r.monthlyPence)}</b>
                        <div className="muted">≈ {money(r.monthlyPence * 12)} a year</div>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None spotted yet — upload at least three months of statements.</p>
              )}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Paid to suppliers (12 months)</h2>
                <Link href="/business/stock" className="muted">
                  Stock →
                </Link>
              </div>
              {insight.suppliers.length ? (
                <ol className="rankbars">
                  {insight.suppliers.slice(0, 12).map((s) => (
                    <li key={s.name}>
                      <div className="rb-top">
                        <span>{s.name}</span>
                        <b>{money(s.pence)}</b>
                      </div>
                      <div className="rb-track">
                        <div className="rb-fill" style={{ width: `${Math.max(3, (s.pence / insight.suppliers[0].pence) * 100)}%` }} />
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No payments to known golf suppliers found yet.</p>
              )}
            </section>
          </div>

          <details className="panel tx-panel" id="transactions" open={Boolean(category || sp.q)}>
            <summary>
              <h2>
                Transactions{category ? ` · ${category}` : ''}
                <span className="muted tx-count">
                  {txs.length >= 500 ? '500+' : txs.length.toLocaleString('en-GB')} · {uncategorised} to sort
                </span>
              </h2>
              <span className="tx-toggle muted" aria-hidden="true" />
            </summary>
            <div className="tx-tools">
              <form action="/business/bank#transactions" className="txsearch">
                <input type="hidden" name="months" value={months} />
                {category ? <input type="hidden" name="category" value={category} /> : null}
                <input name="q" defaultValue={sp.q} placeholder="Search descriptions…" className="search" />
              </form>
              {category || sp.q ? (
                <Link href={qs({ category: '', q: '' })} className="muted">
                  Show all transactions
                </Link>
              ) : (
                <Link href={`${qs({ category: 'Other spending' })}#transactions`} className="muted">
                  Show only “Other spending” to sort
                </Link>
              )}
            </div>
            <div className="tablewrap">
            <table className="compact txs">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {txs.map(({ t }) => (
                  <tr key={t.id}>
                    <td className="nowrap">{t.date}</td>
                    <td>{t.description}</td>
                    <td className="num">{t.amountPence > 0 ? money(t.amountPence) : ''}</td>
                    <td className="num">{t.amountPence < 0 ? money(-t.amountPence) : ''}</td>
                    <td>
                      <CategoryPicker value={t.category} categories={BANK_CATEGORIES} action={setCategoryAction.bind(null, t.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {txs.length >= 500 ? <p className="muted">Showing the latest 500 — narrow the period or search to see more.</p> : null}
            {!txs.length ? <p className="muted">No transactions match.</p> : null}
          </details>
        </>
      ) : null}

      <div className="split" style={{ marginTop: 18 }}>
        <section className="panel">
          <h2>Upload a statement</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Any UK bank’s CSV export works. Upload overlapping statements freely — transactions already in COS are skipped. Change a category once and
            COS remembers it for similar transactions.
          </p>
          <StatementUploadForm action={uploadStatementAction} />
        </section>
        <section className="panel">
          <h2>Uploaded statements</h2>
          {statements.length ? (
            <ul className="attention">
              {statements.map((st) => (
                <li key={st.id}>
                  <span>
                    <b>{st.accountName || st.fileName}</b>
                    <div className="muted">
                      {st.fromDate} → {st.toDate} · {st.transactionCount} added{st.duplicatesSkipped ? ` · ${st.duplicatesSkipped} duplicates skipped` : ''}
                    </div>
                  </span>
                  <ActionButton action={removeStatementAction.bind(null, st.id)} className="linkbtn danger" confirm="Remove this statement’s transactions from the figures?">
                    Remove
                  </ActionButton>
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
