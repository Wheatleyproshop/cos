import Link from 'next/link';
import { PERIODS, type Bucket, type Performance, type Ranked, type Turnaround } from '@/lib/analytics';
import { money } from '@/lib/format';

const short = (pence: number) =>
  pence === 0 ? '£0' : pence >= 100_000_00 ? `£${(pence / 100_000_00).toFixed(1)}m` : pence >= 1_000_00 ? `£${(pence / 1_000_00).toFixed(pence >= 10_000_00 ? 0 : 1)}k` : `£${Math.round(pence / 100)}`;

const PALETTE = ['#16233a', '#2f80ff', '#7fb2ff', '#b08a2e', '#5b6b84', '#c9d6ea'];

/** Order value per week/month as bars, with the number of orders as a line. */
function TrendChart({ data }: { data: Bucket[] }) {
  const W = 680;
  const H = 230;
  const pad = { l: 46, r: 34, t: 14, b: 34 };
  const maxV = Math.max(1, ...data.map((d) => d.valuePence));
  const maxC = Math.max(1, ...data.map((d) => d.count));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = iw / Math.max(1, data.length);
  const y = (v: number) => pad.t + ih - (v / maxV) * ih;
  const yc = (c: number) => pad.t + ih - (c / maxC) * ih;
  const every = Math.ceil(data.length / 8);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${pad.l + bw * i + bw / 2},${yc(d.count)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Order value and number of orders over time">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} className="grid" />
          <text x={pad.l - 6} y={pad.t + ih * (1 - f) + 4} textAnchor="end" className="axis">
            {short(maxV * f)}
          </text>
          <text x={W - pad.r + 6} y={pad.t + ih * (1 - f) + 4} className="axis">
            {Math.round(maxC * f)}
          </text>
        </g>
      ))}
      {data.map((d, i) => (
        <g key={i}>
          <rect x={pad.l + bw * i + bw * 0.18} y={y(d.valuePence)} width={bw * 0.64} height={pad.t + ih - y(d.valuePence)} rx={3} className="bar">
            <title>{`${d.label}: ${money(d.valuePence)} · ${d.count} order${d.count === 1 ? '' : 's'}`}</title>
          </rect>
          {i % every === 0 ? (
            <text x={pad.l + bw * i + bw / 2} y={H - 12} textAnchor="middle" className="axis">
              {d.label}
            </text>
          ) : null}
        </g>
      ))}
      <path d={line} className="line" />
      {data.map((d, i) => (
        <circle key={i} cx={pad.l + bw * i + bw / 2} cy={yc(d.count)} r={3} className="dot" />
      ))}
    </svg>
  );
}

function RankBars({ rows, by = 'value', empty }: { rows: Ranked[]; by?: 'value' | 'count'; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => (by === 'value' ? r.valuePence : r.count)), 1);
  return (
    <ol className="rankbars">
      {rows.map((r, i) => {
        const v = by === 'value' ? r.valuePence : r.count;
        return (
          <li key={r.name}>
            <div className="rb-top">
              <span>
                <span className="rb-pos">{i + 1}</span>
                {r.name}
              </span>
              <b>{by === 'value' ? money(r.valuePence) : r.count}</b>
            </div>
            <div className="rb-track">
              <div className="rb-fill" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
            </div>
            <small>
              {r.count} sold{by === 'count' ? ` · ${money(r.valuePence)}` : ''}
            </small>
          </li>
        );
      })}
    </ol>
  );
}

function Donut({ rows }: { rows: Ranked[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!total) return <p className="muted">No orders in this period.</p>;
  let acc = 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="donutwrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Order mix">
        {rows.map((r, i) => {
          const frac = r.count / total;
          const el = (
            <circle
              key={r.name}
              cx="70" cy="70" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="22"
              strokeDasharray={`${frac * C} ${C}`} strokeDashoffset={-acc * C} transform="rotate(-90 70 70)"
            >
              <title>{`${r.name}: ${r.count}`}</title>
            </circle>
          );
          acc += frac;
          return el;
        })}
        <text x="70" y="67" textAnchor="middle" className="donut-n">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" className="axis">
          orders
        </text>
      </svg>
      <ul className="legend">
        {rows.map((r, i) => (
          <li key={r.name}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            <span>{r.name}</span>
            <b>
              {Math.round((r.count / total) * 100)}% · {money(r.valuePence)}
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnaroundTable({ rows }: { rows: Turnaround[] }) {
  if (!rows.length) {
    return <p className="muted">Turnaround appears once orders in this period have arrived in store (marked Ready for collection).</p>;
  }
  const max = Math.max(...rows.map((r) => r.maxDays), 1);
  return (
    <div className="tablewrap">
      <table className="compact turnaround">
        <thead>
          <tr>
            <th>Manufacturer</th>
            <th className="num">Orders</th>
            <th className="num">Average</th>
            <th>Fastest – slowest</th>
            <th className="num" title="From being ordered with the supplier to arriving in store">Supplier lead</th>
            <th className="num">Delayed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.brand}>
              <td>
                <b>{r.brand}</b>
              </td>
              <td className="num">{r.orders}</td>
              <td className="num">
                <b>{r.avgDays} days</b>
                <div className="muted">median {r.medianDays}</div>
              </td>
              <td>
                <div className="range" aria-label={`${r.minDays} to ${r.maxDays} days`}>
                  <span className="range-bar" style={{ left: `${(r.minDays / max) * 100}%`, width: `${Math.max(2, ((r.maxDays - r.minDays) / max) * 100)}%` }} />
                  <span className="range-avg" style={{ left: `${(r.avgDays / max) * 100}%` }} />
                </div>
                <small className="muted">
                  {r.minDays}–{r.maxDays} days
                </small>
              </td>
              <td className="num">{r.supplierAvgDays === null ? '—' : `${r.supplierAvgDays} days`}</td>
              <td className="num">
                <span className={r.delayedPct >= 25 ? 'flag' : ''}>{r.delayedPct}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Change({ pct, period }: { pct: number | null; period: string }) {
  if (pct === null) return null;
  return (
    <span className={`delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}`} title={`Compared with the previous ${period}`}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '•'} {Math.abs(pct)}%
    </span>
  );
}

export function PerformanceView({ data, canExport }: { data: Performance; canExport?: boolean }) {
  const k = data.kpis;
  const per = data.period.label.toLowerCase();
  const cards = [
    {
      label: 'Order value',
      value: money(k.valuePence),
      note: (
        <>
          <Change pct={k.valueChange} period={per} /> {k.valueChange === null ? 'in this period' : `vs previous ${per}`}
        </>
      ),
    },
    {
      label: 'Orders',
      value: String(k.orders),
      note: (
        <>
          <Change pct={k.ordersChange} period={per} /> avg {money(k.avgOrderPence)} · {k.customers} customer{k.customers === 1 ? '' : 's'}
        </>
      ),
    },
    {
      label: 'Quotes approved',
      value: k.approvalRate === null ? '—' : `${k.approvalRate}%`,
      note: k.quotes ? `${k.quotesApproved} of ${k.quotes}${k.avgApproveDays !== null ? ` · ${k.avgApproveDays} days to approve` : ''}` : 'No quotes sent',
    },
    { label: 'Average turnaround', value: k.avgTurnaroundDays === null ? '—' : `${k.avgTurnaroundDays} days`, note: `Order to in store · ${k.arrived} arrived` },
    { label: 'Repeat customers', value: k.repeatPct === null ? '—' : `${k.repeatPct}%`, note: 'Have ordered before' },
    { label: 'In the pipeline', value: money(k.openValuePence), note: `${k.openOrders} open order${k.openOrders === 1 ? '' : 's'}` },
  ];
  return (
    <div className="perf">
      <div className="perf-bar">
        <div className="pills" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <Link key={p.key} href={`/?view=performance&period=${p.key}`} className={`pill${p.key === data.period.key ? ' selected' : ''}`} scroll={false} aria-current={p.key === data.period.key ? 'page' : undefined}>
              {p.label}
            </Link>
          ))}
        </div>
        {canExport ? (
          <a className="btn small" href={`/api/export/performance?period=${data.period.key}`} download>
            ⤓ Download CSV
          </a>
        ) : null}
      </div>

      <div className="grid">
        {cards.map((c) => (
          <div key={c.label} className="metric">
            <small>{c.label}</small>
            <strong className="metric-money">{c.value}</strong>
            <em>{c.note}</em>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Sales trend</h2>
          <span className="muted">
            <span className="key key-bar" /> Order value <span className="key key-line" /> Orders
          </span>
        </div>
        {k.orders ? <TrendChart data={data.trend} /> : <p className="muted">No orders in this period yet.</p>}
      </section>

      <div className="perf-grid">
        <section className="panel">
          <h2>Best-selling brands</h2>
          <RankBars rows={data.brands} empty="No sales in this period." />
        </section>
        <section className="panel">
          <h2>Best-selling products</h2>
          <RankBars rows={data.products} by="count" empty="No sales in this period." />
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Manufacturer turnaround</h2>
          <span className="muted">Days from order taken to arriving in store</span>
        </div>
        <TurnaroundTable rows={data.turnaround} />
      </section>

      <div className="perf-grid">
        <section className="panel">
          <h2>Order mix</h2>
          <Donut rows={data.mix} />
        </section>
        <section className="panel">
          <h2>What’s selling</h2>
          <RankBars rows={data.categories} by="count" empty="No sales in this period." />
        </section>
      </div>

      <section className="panel">
        <h2>Sales by team member</h2>
        <RankBars rows={data.team} empty="No orders in this period." />
      </section>
    </div>
  );
}
