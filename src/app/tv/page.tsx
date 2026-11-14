import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BrandCards, BrandDonut } from '@/components/dashboard';
import { LiveUpdates } from '@/components/live-updates';
import { TvControls } from '@/components/tv-controls';
import { getPerformance, parsePeriod, PERIODS } from '@/lib/analytics';
import { getStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { listWork, metrics } from '@/lib/queries';

export const metadata: Metadata = { title: 'Shop TV' };

/**
 * Full-screen TV mode for a screen in the shop: brand performance, what's selling and today's
 * workload in large type, refreshing itself every minute. Deliberately shows no customer names or
 * spending, as customers can see it. Read-only, so a shared shop login doesn't need to pick a member.
 */
export default async function ShopTv({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const staff = await getStaff();
  if (!staff) redirect('/login');
  const sp = await searchParams;
  const period = parsePeriod(sp.period ?? '30d');
  const [data, work] = await Promise.all([getPerformance(staff.org, period), listWork(staff.org, { scope: 'overview' })]);
  const m = metrics(work.all);
  const k = data.kpis;
  const per = data.period.label.toLowerCase();
  const maxTrend = Math.max(1, ...data.trend.map((b) => b.valuePence));
  const updatedAt = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: staff.org.timezone });
  const tiles = [
    { label: `Sales · ${per}`, value: money(k.valuePence).replace(/\.\d\d$/, ''), note: k.valueChange === null ? '' : `${k.valueChange > 0 ? '▲' : k.valueChange < 0 ? '▼' : '•'} ${Math.abs(k.valueChange)}% vs previous`, up: (k.valueChange ?? 0) >= 0 },
    { label: `Orders · ${per}`, value: String(k.orders), note: `avg ${money(k.avgOrderPence).replace(/\.\d\d$/, '')}` },
    { label: 'On order now', value: String(m.active), note: `${m.awaiting} awaiting supplier` },
    { label: 'Ready to collect', value: String(m.ready), note: 'customers notified' },
  ];

  return (
    <div className="tv">
      <header className="tv-head">
        <div>
          <p className="tv-eyebrow">{staff.org.storeName}</p>
          <h1>Shop dashboard</h1>
          <nav className="tv-periods" aria-label="Period">
            {PERIODS.map((p) => (
              <Link key={p.key} href={`/tv?period=${p.key}`} className={p.key === period ? 'on' : ''} scroll={false}>
                {p.label}
              </Link>
            ))}
            <LiveUpdates updatedAt={updatedAt} />
          </nav>
        </div>
        <TvControls tz={staff.org.timezone} />
      </header>

      <div className="tv-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="tv-tile">
            <small>{t.label}</small>
            <strong>{t.value}</strong>
            {t.note ? <em className={t.up === false ? 'down' : t.up ? 'up' : ''}>{t.note}</em> : null}
          </div>
        ))}
      </div>

      <div className="tv-row">
        <section className="tv-panel">
          <h2>Brand performance</h2>
          <BrandDonut rows={data.brandShare} />
        </section>
        <section className="tv-panel">
          <h2>Sales over time</h2>
          {k.orders ? (
            <div className="dash-spark tv-spark">
              {data.trend.map((b, i) => (
                <div key={i} className="dash-spark-col">
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

      <section className="tv-panel">
        <h2>Most ordered, by brand</h2>
        <BrandCards data={data} />
      </section>
    </div>
  );
}
