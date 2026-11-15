import type { Metadata } from 'next';
import Link from 'next/link';
import { FinanceSettingsForm } from '@/components/business-ui';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { businessAdvice } from '@/lib/services/business/adviser';
import { CT } from '@/lib/services/business/tax';
import { financeSettingsAction } from '../../actions';

export const metadata: Metadata = { title: 'Adviser · Business' };
export const maxDuration = 60;

const pounds = (p: number) => `${p < 0 ? '−' : ''}£${Math.abs(Math.round(p / 100)).toLocaleString('en-GB')}`;
const date = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const PRIORITY = { 1: 'This week', 2: 'This month', 3: 'When you can' } as const;

export default async function AdviserPage() {
  const staff = await requireBusiness();
  const a = await businessAdvice(staff.org);
  const groups = ([1, 2, 3] as const).map((p) => ({ p, items: a.advice.filter((x) => x.priority === p) })).filter((g) => g.items.length);
  const ct = a.ct;
  return (
    <>
      <PageHeader staff={staff} title="Your business adviser." sub="What to do next, what to put aside for tax, and why — from your sales, stock, bank and payroll." actions={<span />} />

      <section className="panel adviser">
        <div className="panel-head">
          <h2>What I’d do next</h2>
          <span className="muted">{a.advice.length} suggestions, most important first</span>
        </div>
        {groups.length ? (
          groups.map((g) => (
            <div key={g.p} className="adv-group">
              <h3 className={`adv-when p${g.p}`}>{PRIORITY[g.p]}</h3>
              <ol className="adv-list">
                {g.items.map((x) => (
                  <li key={x.title}>
                    <span className={`adv-area area-${x.area.replace(/[^a-z]/gi, '').toLowerCase()}`}>{x.area}</span>
                    <span className="adv-body">
                      <b>{x.href ? <Link href={x.href}>{x.title}</Link> : x.title}</b>
                      <small>{x.detail}</small>
                    </span>
                    {x.worthPence ? <span className="adv-worth">{pounds(x.worthPence)}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ))
        ) : (
          <p className="muted">Nothing needs your attention right now.</p>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Suggestions are rules of thumb worked out from your own figures — not financial or tax advice. Check anything important with your accountant.
        </p>
      </section>

      <section className="panel" id="tax" style={{ scrollMarginTop: 20, marginTop: 18 }}>
        <div className="panel-head">
          <h2>Tax planner</h2>
          <span className="muted">estimates to plan cash — your returns are the final figures</span>
        </div>

        {a.vat ? (
          <>
            <h3>VAT {a.fin.vatScheme === 'flat' ? `(flat rate ${a.fin.flatRatePct}%)` : ''}</h3>
            <div className="vat-quarters">
              {a.vat.quarters.map((q) => (
                <div key={q.start} className={`vat-q${q.current ? ' current' : ''}`}>
                  <small>
                    {q.current ? 'This quarter' : q.future ? 'Next quarter' : 'Last quarter'} · {q.label}
                  </small>
                  <strong>{pounds(q.payable)}</strong>
                  <em>due {date(q.due)}</em>
                  <dl>
                    <dt>Sales (incl. VAT)</dt>
                    <dd>{pounds(q.salesInclVat)}</dd>
                    <dt>VAT on sales</dt>
                    <dd>{pounds(q.outputVat)}</dd>
                    {a.fin.vatScheme === 'standard' ? (
                      <>
                        <dt>VAT on purchases</dt>
                        <dd>
                          −{pounds(q.inputVat)} <span className="muted">{q.inputFrom === 'bank' ? 'from bank' : 'estimated'}</span>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {q.estimatedShare > 0 ? <p className="muted small">{q.estimatedShare}% of this quarter is projected from the current rate of sale.</p> : null}
                </div>
              ))}
            </div>
            <p className="muted small">
              Sales from Shopify (till and website), with credit vouchers counted as payment — VAT is due on the full price when trade-in credit is used.
              {a.vat.quarters.some((q) => q.inputFrom === 'estimate') ? ' Purchase VAT is estimated from what you sold at cost until bank statements cover the quarter.' : ''} Sales taken
              outside Shopify aren’t included.
            </p>
          </>
        ) : (
          <p className="muted">Not VAT registered (change below).</p>
        )}

        {ct ? (
          <>
            <h3 style={{ marginTop: 22 }}>Corporation tax — {ct.label}</h3>
            <div className="ct-grid">
              <div className="ct-steps">
                <div>
                  <span>Sales (less VAT), full year</span>
                  <b>{pounds(ct.salesExVat)}</b>
                </div>
                <div>
                  <span>Gross profit {ct.marginPct !== null ? `(${ct.marginPct}% margin)` : ''}</span>
                  <b>{ct.grossProfit === null ? '—' : pounds(ct.grossProfit)}</b>
                </div>
                <div>
                  <span>Running costs {ct.overheads === null ? '(upload bank statements)' : '(from bank)'}</span>
                  <b>{ct.overheads === null ? 'not included' : `−${pounds(ct.overheads)}`}</b>
                </div>
                <div>
                  <span>Staff costs {ct.staffFrom === 'payroll' ? '(pay runs)' : ct.staffFrom === 'bank' ? '(from bank)' : '(none recorded)'}</span>
                  <b>−{pounds(ct.staff)}</b>
                </div>
                <div className="ct-total">
                  <span>Estimated profit</span>
                  <b>{ct.profit === null ? '—' : pounds(ct.profit)}</b>
                </div>
              </div>
              <div className="ct-tax">
                <small>Estimated corporation tax</small>
                <strong>{ct.tax === null ? '—' : pounds(ct.tax)}</strong>
                <em>due {date(ct.due)}</em>
                {ct.perMonth ? <p>Put aside about <b>{pounds(ct.perMonth)}</b> a month.</p> : null}
              </div>
            </div>
            <p className="muted small">
              The year is projected from {Math.round(ct.salesDays / 7)} weeks of sales — golf is seasonal, so this firms up as the year goes on. Rates:{' '}
              {CT.small * 100}% on profits up to £{(CT.lower / 100).toLocaleString('en-GB')}, {CT.main * 100}% over £{(CT.upper / 100).toLocaleString('en-GB')}, with
              marginal relief between. Not included: capital allowances, depreciation, directors’ pay or dividends, and other income — your accountant will adjust for these.
            </p>
          </>
        ) : null}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Tax settings</h2>
        <FinanceSettingsForm
          action={financeSettingsAction}
          values={{ vatRegistered: a.fin.vatRegistered, vatStagger: a.fin.vatStagger, vatScheme: a.fin.vatScheme, flatRatePct: a.fin.flatRatePct, yearEndMonth: a.fin.yearEndMonth, limitedCompany: a.fin.limitedCompany }}
        />
      </section>
    </>
  );
}
