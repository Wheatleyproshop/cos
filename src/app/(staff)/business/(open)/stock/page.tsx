import type { Metadata } from 'next';
import Link from 'next/link';
import { StockUploadForm } from '@/components/business-ui';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { spendingInsights } from '@/lib/services/business/insights';
import { commitments, stockReport, type Breakdown } from '@/lib/services/business/stock';
import { removeStockAction, uploadStockAction } from '../../actions';

export const metadata: Metadata = { title: 'Stock & commitments · Business' };

const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString('en-GB')}`;
const monthLabel = (ym: string) => (/^\d{4}-\d{2}$/.test(ym) ? new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : ym);

function Bars({ rows, value, label, empty }: { rows: { name: string }[]; value: (r: never) => number; label: (r: never) => string; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => value(r as never)));
  return (
    <ol className="rankbars">
      {rows.slice(0, 12).map((r) => (
        <li key={r.name}>
          <div className="rb-top">
            <span>{r.name}</span>
            <b>{pounds(value(r as never))}</b>
          </div>
          <div className="rb-track">
            <div className="rb-fill" style={{ width: `${Math.max(3, (value(r as never) / max) * 100)}%` }} />
          </div>
          <small>{label(r as never)}</small>
        </li>
      ))}
    </ol>
  );
}

export default async function StockPage() {
  const staff = await requireBusiness();
  const today = todayInTz(staff.org.timezone);
  const [y, m] = today.split('-').map(Number);
  const yearFrom = new Date(Date.UTC(y - 1, m, 1)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const [report, committed, spend] = await Promise.all([stockReport(staff.organisationId), commitments(staff.organisationId), spendingInsights(staff.organisationId, yearFrom, next, 12)]);
  const s = report.latest;
  const margin = s && s.retailPence ? Math.round(((s.retailPence - s.costPence) / s.retailPence) * 100) : null;

  // One row per brand: held, committed, customer orders, and paid to that supplier in the last 12 months.
  const brands = new Map<string, { name: string; held: number; retail: number; prebook: number; customer: number; paid: number | null }>();
  const row = (name: string) => {
    const k = name.toLowerCase();
    const r = brands.get(k) ?? { name, held: 0, retail: 0, prebook: 0, customer: 0, paid: null };
    brands.set(k, r);
    return r;
  };
  s?.byBrand.forEach((b: Breakdown) => Object.assign(row(b.name), { held: b.costPence, retail: b.retailPence }));
  committed.byBrand.forEach((b) => (row(b.name).prebook = b.pence));
  committed.customerOrders.byBrand.forEach((b) => (row(b.name).customer = b.pence));
  for (const sp of spend.suppliers) for (const part of sp.name.split(' & ')) {
    const r = brands.get(part.toLowerCase());
    if (r) r.paid = (r.paid ?? 0) + Math.round(sp.pence / sp.name.split(' & ').length);
  }
  const brandRows = [...brands.values()].sort((a, b) => b.held + b.prebook - (a.held + a.prebook));
  const totalCommitted = committed.prebookCostPence;

  return (
    <>
      <PageHeader staff={staff} title="Stock & commitments." sub="What’s on the shelves, what’s on its way, and where the money is tied up — by brand and category." actions={<span />} />

      <div className="grid biz-kpis">
        <div className="metric">
          <small>Stock held (at cost)</small>
          <strong className="metric-money">{s ? pounds(s.costPence) : '—'}</strong>
          <em>
            {s
              ? `${s.units.toLocaleString('en-GB')} items · counted ${s.snap.takenOn}${s.prev ? ` · ${s.costPence >= s.prevCostPence ? '▲' : '▼'} ${pounds(Math.abs(s.costPence - s.prevCostPence))} since ${s.prev.takenOn}` : ''}`
              : 'upload a stock count below'}
          </em>
        </div>
        <div className="metric">
          <small>Stock at selling price</small>
          <strong className="metric-money">{s ? pounds(s.retailPence) : '—'}</strong>
          <em>{margin !== null ? `${margin}% margin if it all sold at full price` : ' '}</em>
        </div>
        <div className="metric">
          <small>Committed: pre-books due</small>
          <strong className="metric-money">{pounds(totalCommitted)}</strong>
          <em>
            {committed.prebookUnits.toLocaleString('en-GB')} items at cost still to arrive{committed.draftCostPence ? ` · plus ${pounds(committed.draftCostPence)} in drafts not yet placed` : ''}
          </em>
        </div>
        <div className="metric">
          <small>Customer orders on order</small>
          <strong className="metric-money">{pounds(committed.customerOrders.placedPence)}</strong>
          <em>already sold (customer prices){committed.customerOrders.toPlacePence ? ` · ${pounds(committed.customerOrders.toPlacePence)} still to place` : ''}</em>
        </div>
        <div className="metric">
          <small>Total tied up in stock</small>
          <strong className="metric-money">{pounds((s?.costPence ?? 0) + totalCommitted)}</strong>
          <em>held + pre-books due, at cost</em>
        </div>
      </div>

      {s && (s.noCost || s.negative) ? (
        <div className="notice warn">
          {s.noCost ? (
            <>
              <b>{s.noCost} lines ({s.noCostUnits} items) have no cost price</b>, so they’re left out of the stock value. Add a cost per item in Shopify, then upload a fresh product export.{' '}
            </>
          ) : null}
          {s.negative ? <b>{s.negative} lines show negative stock — usually items sold before they were booked in.</b> : null}
        </div>
      ) : null}

      <section className="panel tablewrap">
        <div className="panel-head">
          <h2>By brand</h2>
          <span className="muted">held, on its way, and paid to the supplier (last 12 months of bank statements)</span>
        </div>
        {brandRows.length ? (
          <table className="compact">
            <thead>
              <tr>
                <th>Brand</th>
                <th className="num">Held (cost)</th>
                <th className="num">Held (retail)</th>
                <th className="num">Pre-books due</th>
                <th className="num">Tied up</th>
                <th className="num">Customer orders</th>
                <th className="num">Paid to supplier</th>
              </tr>
            </thead>
            <tbody>
              {brandRows.slice(0, 40).map((b) => (
                <tr key={b.name}>
                  <td>
                    <b>{b.name}</b>
                  </td>
                  <td className="num">{b.held ? pounds(b.held) : '—'}</td>
                  <td className="num">{b.retail ? pounds(b.retail) : '—'}</td>
                  <td className="num">{b.prebook ? pounds(b.prebook) : '—'}</td>
                  <td className="num">
                    <b>{pounds(b.held + b.prebook)}</b>
                  </td>
                  <td className="num">{b.customer ? pounds(b.customer) : '—'}</td>
                  <td className="num">{b.paid !== null ? pounds(b.paid) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Upload a stock count, or add pre-books, to see this by brand.</p>
        )}
      </section>

      <div className="perf-grid">
        <section className="panel">
          <h2>Stock held by category</h2>
          <Bars
            rows={s?.byCategory ?? []}
            value={(r: Breakdown) => r.costPence}
            label={(r: Breakdown) => `${r.units.toLocaleString('en-GB')} items · ${pounds(r.retailPence)} at retail`}
            empty="Upload a stock count to see this."
          />
        </section>
        <section className="panel">
          <h2>Pre-books due by category</h2>
          <Bars rows={committed.byCategory} value={(r: { pence: number }) => r.pence} label={(r: { n: number }) => `${r.n} line${r.n === 1 ? '' : 's'}`} empty="No pre-books on order." />
        </section>
      </div>

      <div className="perf-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Due in by month</h2>
            <Link href="/prebook" className="muted">
              Pre-books →
            </Link>
          </div>
          <Bars
            rows={committed.byMonth.map((x) => ({ ...x, name: monthLabel(x.month) }))}
            value={(r: { costPence: number }) => r.costPence}
            label={(r: { units: number }) => `${r.units} items`}
            empty="Nothing due."
          />
        </section>
        <section className="panel">
          <h2>Most money tied up in</h2>
          {s?.top.length ? (
            <ul className="attention">
              {s.top.map((i) => (
                <li key={i.id}>
                  <span>
                    <b>{i.title}</b>
                    <div className="muted">
                      {[i.brand, i.variant, `${i.quantity} in stock`].filter(Boolean).join(' · ')}
                    </div>
                  </span>
                  <b>{pounds(i.quantity * (i.costPence ?? 0))}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Upload a stock count to see this.</p>
          )}
        </section>
      </div>

      <div className="split" style={{ marginTop: 18 }}>
        <section className="panel">
          <h2>Upload stock</h2>
          <ol className="steps-list">
            <li>
              <b>Costs, brands and types</b> (now and then): Shopify → Products → <b>Export</b> → all products → CSV. COS keeps this list and updates it each time.
            </li>
            <li>
              <b>Quantities</b> (whenever you want a stock check): Shopify → Products → <b>Inventory</b> → <b>Export</b>. Each upload is a dated count, so you
              can see stock value change over time.
            </li>
            <li>Using another till or stock system? Any CSV with SKU and quantity works (add cost, price, brand and category columns if it has them).</li>
          </ol>
          <StockUploadForm action={uploadStockAction} today={today} />
          <p className="muted" style={{ marginBottom: 0 }}>
            Product list: {report.catalogue.n ? `${Number(report.catalogue.n).toLocaleString('en-GB')} variants${report.catalogue.updated ? `, updated ${new Date(report.catalogue.updated).toLocaleDateString('en-GB')}` : ''}` : 'not uploaded yet'}.
          </p>
        </section>
        <section className="panel">
          <h2>Stock counts</h2>
          {report.snaps.length ? (
            <ul className="attention">
              {report.snaps.map((sn) => (
                <li key={sn.id}>
                  <span>
                    <b>{sn.takenOn}</b>
                    <div className="muted">
                      {sn.fileName} · {sn.lines} lines{sn.unmatched ? ` · ${sn.unmatched} without a cost` : ''}
                      {sn.location ? ` · ${sn.location}` : ''}
                    </div>
                  </span>
                  <ActionButton action={removeStockAction.bind(null, sn.id)} className="linkbtn danger" confirm="Remove this stock count?">
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
