import Link from 'next/link';
import { Icon } from '@/components/icons';
import { LiveUpdates } from '@/components/live-updates';
import { PERIODS, type Performance, type Ranked } from '@/lib/analytics';
import { money } from '@/lib/format';
import { shortDate } from '@/lib/short-date';

/**
 * The landing dashboard: headline figures, each brand's share of sales (donut), what's being
 * ordered most from each brand, and the highest-value orders. Server-rendered SVG, no client JS.
 * Brand colours follow a fixed order (slot 0 = biggest brand); "Other brands" is always grey.
 */

/** Whole pounds for the small figures: £1,299 rather than £1,299.00. */
const pounds = (pence: number) => money(pence).replace(/\.00$/, '');
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
const slot = (name: string, i: number) => (name === 'Other brands' ? 'dc-other' : `dc-${i}`);

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function BrandDonut({ rows }: { rows: Ranked[] }) {
  const total = rows.reduce((s, r) => s + r.valuePence, 0);
  if (!total) return <p className="muted">No sales in this period yet.</p>;
  let a = 0;
  return (
    <div className="dash-donut">
      <svg viewBox="0 0 200 200" role="img" aria-label={`Share of sales by brand: ${rows.map((r) => `${r.name} ${pct(r.valuePence, total)}%`).join(', ')}`}>
        {rows.map((r, i) => {
          const sweep = (r.valuePence / total) * Math.PI * 2;
          const a0 = a;
          a += sweep;
          if (sweep <= 0) return null;
          const d = rows.length === 1 ? null : arc(100, 100, 58, 92, a0, a0 + sweep - 0.0001);
          return d ? (
            <path key={r.name} d={d} className={`dash-seg ${slot(r.name, i)}`}>
              <title>{`${r.name}: ${money(r.valuePence)} (${pct(r.valuePence, total)}%) · ${r.count} item${r.count === 1 ? '' : 's'}`}</title>
            </path>
          ) : (
            <circle key={r.name} cx="100" cy="100" r="75" fill="none" strokeWidth="34" className={`dash-ring ${slot(r.name, i)}`}>
              <title>{`${r.name}: ${money(r.valuePence)} (100%)`}</title>
            </circle>
          );
        })}
        <text x="100" y="98" textAnchor="middle" className="dash-donut-n">
          {money(total).replace(/\.\d\d$/, '')}
        </text>
        <text x="100" y="118" textAnchor="middle" className="dash-donut-l">
          total sales
        </text>
      </svg>
      <ul className="dash-legend">
        {rows.map((r, i) => (
          <li key={r.name}>
            <i className={slot(r.name, i)} aria-hidden="true" />
            <span>{r.name}</span>
            <b>{money(r.valuePence)}</b>
            <em>{pct(r.valuePence, total)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Change({ pct: p, per }: { pct: number | null; per: string }) {
  if (p === null) return <>{per === 'all time' ? 'all time' : `in the last ${per}`}</>;
  return (
    <>
      <span className={`delta ${p > 0 ? 'up' : p < 0 ? 'down' : ''}`}>
        {p > 0 ? '▲' : p < 0 ? '▼' : '•'} {Math.abs(p)}%
      </span>{' '}
      vs previous {per}
    </>
  );
}

export function Dashboard({ data, canExport, updatedAt }: { data: Performance; canExport?: boolean; updatedAt: string }) {
  const k = data.kpis;
  const per = data.period.label.toLowerCase();
  const shareTotal = data.brandShare.reduce((s, r) => s + r.valuePence, 0);
  const tiles = [
    { icon: 'orders', label: 'Sales', value: money(k.valuePence), note: <Change pct={k.valueChange} per={per} /> },
    { icon: 'check', label: 'Orders', value: String(k.orders), note: <Change pct={k.ordersChange} per={per} /> },
    { icon: 'quotes', label: 'Average order', value: money(k.avgOrderPence), note: `${k.customers} customer${k.customers === 1 ? '' : 's'}` },
    { icon: 'customers', label: 'Repeat customers', value: k.repeatPct === null ? '—' : `${k.repeatPct}%`, note: 'have ordered before' },
    { icon: 'truck', label: 'In the pipeline', value: money(k.openValuePence), note: `${k.openOrders} open order${k.openOrders === 1 ? '' : 's'}` },
  ];
  const maxTrend = Math.max(1, ...data.trend.map((b) => b.valuePence));
  return (
    <div className="perf dash">
      <div className="perf-bar">
        <div className="pills" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <Link key={p.key} href={`/?period=${p.key}`} className={`pill${p.key === data.period.key ? ' selected' : ''}`} scroll={false} aria-current={p.key === data.period.key ? 'page' : undefined}>
              {p.label}
            </Link>
          ))}
        </div>
        <div className="dash-actions">
          <LiveUpdates updatedAt={updatedAt} />
          <Link href={`/?view=performance&period=${data.period.key}`} className="muted">
            Full performance report →
          </Link>
          {canExport ? (
            <a className="btn small" href={`/api/export/dashboard?period=${data.period.key}`} download>
              ⤓ Download
            </a>
          ) : null}
        </div>
      </div>

      <div className="grid dash-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="metric">
            <span className="metric-icon" aria-hidden="true">
              <Icon name={t.icon} size={18} />
            </span>
            <small>{t.label}</small>
            <strong className="metric-money">{t.value}</strong>
            <em>{t.note}</em>
          </div>
        ))}
      </div>

      <div className="dash-row">
        <section className="panel" aria-labelledby="dash-share">
          <div className="panel-head">
            <h2 id="dash-share">Brand performance</h2>
            <span className="muted">Share of sales · {per}</span>
          </div>
          <BrandDonut rows={data.brandShare} />
        </section>

        <section className="panel" aria-labelledby="dash-trend">
          <div className="panel-head">
            <h2 id="dash-trend">Sales over time</h2>
            <span className="muted">{per}</span>
          </div>
          {k.orders ? (
            <div className="dash-spark" role="img" aria-label="Order value over time">
              {data.trend.map((b, i) => (
                <div key={i} className="dash-spark-col" title={`${b.label}: ${money(b.valuePence)} · ${b.count} order${b.count === 1 ? '' : 's'}`}>
                  <div className="dash-spark-bar" style={{ height: `${Math.max(b.valuePence ? 4 : 0, (b.valuePence / maxTrend) * 100)}%` }} />
                  <small>{i % Math.ceil(data.trend.length / 6) === 0 ? b.label : ''}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No orders in this period yet.</p>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="dash-bybrand">
        <div className="panel-head">
          <h2 id="dash-bybrand">Most ordered, by brand</h2>
          <span className="muted">Top products from your five biggest brands</span>
        </div>
        {data.brandProducts.length ? (
          <div className="dash-brands">
            {data.brandProducts.map((b, i) => (
              <article key={b.brand} className="dash-brand">
                <header>
                  <i className={`dash-swatch dc-${i}`} aria-hidden="true" />
                  <h3>{b.brand}</h3>
                  <span className="muted">
                    {pct(b.valuePence, shareTotal)}% of sales
                  </span>
                </header>
                <div className="dash-brand-figs">
                  <div>
                    <b>{pounds(b.valuePence)}</b>
                    <small>sales</small>
                  </div>
                  <div>
                    <b>{b.count}</b>
                    <small>item{b.count === 1 ? '' : 's'}</small>
                  </div>
                  <div>
                    <b>{pounds(Math.round(b.valuePence / Math.max(1, b.count)))}</b>
                    <small>avg per item</small>
                  </div>
                </div>
                <ol>
                  {b.products.map((p) => (
                    <li key={p.name}>
                      <span>{p.name}</span>
                      <b>×{p.count}</b>
                      <em>{money(p.valuePence)}</em>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No sales in this period yet.</p>
        )}
      </section>

      <section className="panel" aria-labelledby="dash-cust">
        <div className="panel-head">
          <h2 id="dash-cust">Best-value customers</h2>
          <span className="muted">Biggest spenders · {per}</span>
        </div>
        {data.topCustomers.length ? (
          <div className="tablewrap">
            <table className="compact dash-cust">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Spent</th>
                  <th className="num">Orders</th>
                  <th className="num">Average order</th>
                  <th>Favourite brand</th>
                </tr>
              </thead>
              <tbody>
                {data.topCustomers.map((c, i) => (
                  <tr key={c.id}>
                    <td>
                      <span className="rb-pos">{i + 1}</span>
                      <Link href={`/customers/${c.id}`} className="rowtitle">
                        {c.name}
                      </Link>
                      {c.lifetimeOrders > c.orders ? <span className="returning dash-ret">Returning</span> : null}
                    </td>
                    <td className="num">
                      <b>{money(c.valuePence)}</b>
                    </td>
                    <td className="num">
                      {c.orders}
                      {c.lifetimeOrders > c.orders ? <small className="muted"> ({c.lifetimeOrders} ever)</small> : null}
                    </td>
                    <td className="num">{money(c.avgOrderPence)}</td>
                    <td>{c.favouriteBrand || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No orders in this period yet.</p>
        )}
      </section>

      <div className="dash-row">
        <section className="panel" aria-labelledby="dash-top">
          <div className="panel-head">
            <h2 id="dash-top">Highest-value orders</h2>
            <span className="muted">{per}</span>
          </div>
          {data.topOrders.length ? (
            <ol className="dash-top">
              {data.topOrders.map((o, i) => (
                <li key={o.orderNumber}>
                  <span className="rb-pos">{i + 1}</span>
                  <span className="dash-top-main">
                    <Link href={`/orders/${o.orderNumber}`} className="rowtitle">
                      {o.customerName || o.orderNumber}
                    </Link>
                    <small className="muted">
                      {o.orderNumber} · {o.brand} {o.product} · {shortDate(o.createdAt.toISOString().slice(0, 10))}
                    </small>
                  </span>
                  <b>{money(o.valuePence)}</b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No orders in this period yet.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="dash-cats">
          <div className="panel-head">
            <h2 id="dash-cats">What’s selling</h2>
            <span className="muted">By category</span>
          </div>
          {data.categories.length ? (
            <ol className="rankbars">
              {data.categories.slice(0, 6).map((c) => {
                const max = Math.max(1, ...data.categories.map((x) => x.valuePence));
                return (
                  <li key={c.name}>
                    <div className="rb-top">
                      <span>{c.name}</span>
                      <b>{money(c.valuePence)}</b>
                    </div>
                    <div className="rb-track">
                      <div className="rb-fill" style={{ width: `${Math.max(3, (c.valuePence / max) * 100)}%` }} />
                    </div>
                    <small>{c.count} sold</small>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted">No sales in this period yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
