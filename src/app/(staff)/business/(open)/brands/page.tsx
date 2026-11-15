import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { todayInTz } from '@/lib/format';
import { brandReview, salesLines, type Perf } from '@/lib/services/business/brand-review';
import { marginStory, supplierReturn } from '@/lib/services/business/advice';
import { shopifyStatus } from '@/lib/services/business/shopify-sync';
import { setVoucherAction, syncShopifyAction } from '../../actions';

export const metadata: Metadata = { title: 'Brand review · Business' };
export const maxDuration = 300;

const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString('en-GB')}`;
const RANGES = [
  { key: '90', label: '90 days' },
  { key: '180', label: '6 months' },
  { key: '365', label: '12 months' },
];

const VERDICT = { star: '★ Star', review: 'Review', watch: 'Watch' } as const;

function PerfTable({ rows, label, link }: { rows: Perf[]; label: string; link: (name: string) => string }) {
  return (
    <div className="tablewrap">
      <table className="compact review">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Sold</th>
            <th className="num">Sales</th>
            <th className="num" title="Margin on prices less VAT, with credit vouchers counted as money received">Margin</th>
            <th className="num">Stock (cost)</th>
            <th className="num" title="Share of what was available that sold: sold ÷ (sold + still in stock)">Sell-through</th>
            <th className="num" title="How long current stock lasts at the current rate of sale">Stock cover</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.name} className={b.verdict ? `v-${b.verdict}` : ''}>
              <td>
                <Link href={link(b.name)} className="rowtitle">
                  {b.name}
                </Link>
              </td>
              <td className="num">{b.units.toLocaleString('en-GB')}</td>
              <td className="num">
                {pounds(b.salesPence)}
                {b.voucherPence ? <div className="muted small">incl. {pounds(b.voucherPence)} vouchers</div> : null}
              </td>
              <td className="num">
                {b.marginPct === null ? (
                  <span className="muted">no costs</span>
                ) : (
                  <>
                    {b.marginPct}%
                    {b.reportedMarginPct !== null && b.reportedMarginPct !== b.marginPct ? <div className="muted small">looks like {b.reportedMarginPct}%</div> : null}
                  </>
                )}
              </td>
              <td className="num">{b.stockCostPence ? pounds(b.stockCostPence) : '—'}</td>
              <td className="num">{b.sellThroughPct === null ? '—' : `${b.sellThroughPct}%`}</td>
              <td className="num">{b.weeksCover === null ? '—' : b.weeksCover >= 999 ? 'no sales' : `${b.weeksCover} wks`}</td>
              <td>
                {b.verdict ? <span className={`verdict ${b.verdict}`}>{VERDICT[b.verdict]}</span> : null}
                {b.reasons.length ? <div className="muted small">{b.reasons.join(' · ')}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function BrandReviewPage({ searchParams }: { searchParams: Promise<{ days?: string; brand?: string; category?: string }> }) {
  const staff = await requireBusiness();
  const sp = await searchParams;
  const days = RANGES.some((r) => r.key === sp.days) ? Number(sp.days) : 90;
  const today = todayInTz(staff.org.timezone);
  const to = new Date(new Date(`${today}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const from = new Date(new Date(`${to}T12:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const brand = sp.brand?.slice(0, 80);
  const category = brand ? undefined : sp.category?.slice(0, 80);
  const [r, shopify, lines, story, spend] = await Promise.all([
    brandReview(staff.organisationId, from, to),
    shopifyStatus(staff.organisationId),
    brand || category ? salesLines(staff.organisationId, from, to, { brand, category }) : Promise.resolve(null),
    marginStory(staff.organisationId, from, to),
    supplierReturn(staff.organisationId, todayInTz(staff.org.timezone)),
  ]);
  const href = (o: Record<string, string>) => `/business/brands?${new URLSearchParams({ days: String(days), ...o })}#items`;
  const t = r.totals;
  const stars = r.brands.filter((b) => b.verdict === 'star');
  const review = r.brands.filter((b) => b.verdict === 'review').sort((a, b) => b.stockCostPence - a.stockCostPence);
  return (
    <>
      <PageHeader staff={staff} title="Brand review." sub="Which brands earn their shelf space — sales, margin, stock and how fast it turns." actions={<span />} />
      <div className="perf-bar">
        <div className="pills">
          {RANGES.map((x) => (
            <Link key={x.key} href={`/business/brands?days=${x.key}`} className={`pill${days === Number(x.key) ? ' selected' : ''}`} scroll={false}>
              {x.label}
            </Link>
          ))}
        </div>
        {shopify.connected ? (
          <ActionButton action={syncShopifyAction} className="btn small">
            ↻ Sync from Shopify
          </ActionButton>
        ) : null}
      </div>

      {!r.hasSales ? (
        <section className="panel">
          <h2>Waiting for sales from Shopify</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            {shopify.connected
              ? 'Press “Sync from Shopify”. The first time, Shopify prepares 12 months of orders, which can take a few minutes — if it isn’t ready, it finishes on the next sync (or overnight).'
              : 'Once COS is linked to Shopify (see the Stock & commitments tab), sales from the till and website come in every night and this page fills in.'}
          </p>
        </section>
      ) : (
        <>
          <div className="grid biz-kpis">
            <div className="metric">
              <small>Sales (incl. VAT)</small>
              <strong className="metric-money">{pounds(t.salesPence)}</strong>
              <em>
                {t.units.toLocaleString('en-GB')} items · {Math.round(r.weeks)} weeks{r.from !== from ? ` (sales from ${r.from})` : ''}
              </em>
            </div>
            <div className="metric">
              <small>Margin</small>
              <strong className="metric-money">{t.marginPct === null ? '—' : `${t.marginPct}%`}</strong>
              <em>on prices less VAT, where cost is known</em>
            </div>
            <div className="metric">
              <small>Credit vouchers taken</small>
              <strong className="metric-money">{pounds(t.voucherPence)}</strong>
              <em>
                {t.voucherPence && t.reportedMarginPct !== null && t.marginPct !== null
                  ? `would make margin look ${t.reportedMarginPct}% instead of ${t.marginPct}%`
                  : 'mark your voucher discounts below'}
              </em>
            </div>
            <div className="metric">
              <small>Real discounts given</small>
              <strong className="metric-money">{pounds(t.discountPence)}</strong>
              <em>{t.salesPence ? `${Math.round((t.discountPence / (t.salesPence + t.discountPence)) * 100)}% off full price` : ''}</em>
            </div>
            <div className="metric">
              <small>Stock cover</small>
              <strong className="metric-money">{t.weeksCover === null ? '—' : t.weeksCover >= 999 ? '—' : `${t.weeksCover} wks`}</strong>
              <em>{r.snapTakenOn ? `stock counted ${r.snapTakenOn}` : 'no stock count yet'}</em>
            </div>
          </div>

          <div className="perf-grid">
            <section className="panel">
              <h2>★ Stars</h2>
              {stars.length ? (
                <ul className="attention">
                  {stars.map((b) => (
                    <li key={b.name}>
                      <span>
                        <b>{b.name}</b>
                        <div className="muted">
                          {pounds(b.salesPence)} sales · {b.marginPct}% margin · {b.weeksCover} weeks of stock
                        </div>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None stand out yet for this period.</p>
              )}
            </section>
            <section className="panel">
              <h2>Brands to review</h2>
              {review.length ? (
                <ul className="attention">
                  {review.map((b) => (
                    <li key={b.name}>
                      <span>
                        <b>{b.name}</b>
                        <div className="muted">
                          {pounds(b.stockCostPence)} of stock · {b.reasons.join(' · ')}
                        </div>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing worrying — every brand with real money in stock is selling.</p>
              )}
            </section>
          </div>

          {story.length ? (
            <section className="panel" id="why" style={{ scrollMarginTop: 20 }}>
              <div className="panel-head">
                <h2>Why the margins are what they are</h2>
                <span className="muted">items with a cost price · prices less VAT</span>
              </div>
              <div className="tablewrap">
                <table className="compact review">
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th className="num" title="If everything had sold at full price">At full price</th>
                      <th className="num" title="After real discounts (credit vouchers count as money)">After discounts</th>
                      <th className="num" title="How it would look if credit vouchers were treated as discounts">If vouchers were discounts</th>
                      <th>What’s happening</th>
                    </tr>
                  </thead>
                  <tbody>
                    {story.slice(0, 25).map((m) => (
                      <tr key={m.name}>
                        <td>
                          <b>{m.name}</b>
                        </td>
                        <td className="num">{m.fullMargin === null ? '—' : `${m.fullMargin}%`}</td>
                        <td className="num">
                          <b>{m.afterDiscounts === null ? '—' : `${m.afterDiscounts}%`}</b>
                        </td>
                        <td className="num muted">{m.voucherPence && m.ifVoucherCounted !== null ? `${m.ifVoucherCounted}%` : '—'}</td>
                        <td className="small">{m.reasons.length ? m.reasons.join('; ') : <span className="muted">healthy — nothing unusual</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {spend && spend.rows.length ? (
            <section className="panel" id="spend" style={{ scrollMarginTop: 20 }}>
              <div className="panel-head">
                <h2>Spend with suppliers vs what sold</h2>
                <span className="muted">
                  same {spend.weeks} weeks ({spend.from} to {spend.to}) · bank statements and Shopify
                </span>
              </div>
              <div className="tablewrap">
                <table className="compact review">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th className="num">Paid (incl. VAT)</th>
                      <th className="num">Sales of their brands</th>
                      <th className="num" title="Sales for every £1 paid to the supplier">Sales per £1 paid</th>
                      <th className="num" title="What the items sold cost you">Cost of what sold</th>
                      <th className="num">Stock held now</th>
                      <th>What’s happening</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spend.rows.map((x) => (
                      <tr key={x.name}>
                        <td>
                          <b>{x.name}</b>
                        </td>
                        <td className="num">{pounds(x.paid)}</td>
                        <td className="num">{pounds(x.sales)}</td>
                        <td className="num">{x.perPound === null ? '—' : `£${x.perPound.toFixed(2)}`}</td>
                        <td className="num">{pounds(x.cogs)}</td>
                        <td className="num">{x.stock ? pounds(x.stock) : '—'}</td>
                        <td className="small">{x.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>
                Payments are matched to suppliers by the name on your statement. The period grows as more Shopify sales come in and you upload more statements.
              </p>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h2>All brands</h2>
              <span className="muted">Shopify sales (till and website) · stock from the latest count</span>
            </div>
            <PerfTable rows={r.brands.slice(0, 60)} label="Brand" link={(n) => href({ brand: n })} />
          </section>
          <section className="panel" style={{ marginTop: 18 }}>
            <h2>By category</h2>
            <PerfTable rows={r.categories.slice(0, 30)} label="Category" link={(n) => href({ category: n })} />
          </section>
          {lines ? (
            <section className="panel" id="items" style={{ marginTop: 18, scrollMarginTop: 20 }}>
              <div className="panel-head">
                <h2>Every sale: {brand ?? category}</h2>
                <Link href={`/business/brands?days=${days}`} className="muted">
                  Close
                </Link>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                <b>Sold for</b> is what the shop received for the item: full price less any real discount. Credit vouchers are part of that payment, not a
                price cut.
              </p>
              <div className="tablewrap">
                <table className="compact review">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Item</th>
                      <th className="num">Qty</th>
                      <th className="num">Full price</th>
                      <th className="num">Discount</th>
                      <th className="num">Sold for</th>
                      <th className="num">Paid by credit</th>
                      <th className="num">Paid by other means</th>
                      <th className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td className="nowrap">
                          {l.soldOn}
                          <div className="muted small">
                            {l.orderName} · {l.channel}
                          </div>
                        </td>
                        <td>{l.title}</td>
                        <td className="num">{l.quantity}</td>
                        <td className="num">{pounds(l.fullPence)}</td>
                        <td className="num">
                          {l.discountPence ? pounds(l.discountPence) : '—'}
                          {l.discountNames.length ? <div className="muted small">{l.discountNames.join(', ')}</div> : null}
                        </td>
                        <td className="num">
                          <b>{pounds(l.soldForPence)}</b>
                        </td>
                        <td className="num">{l.creditPence ? pounds(l.creditPence) : '—'}</td>
                        <td className="num">{pounds(l.paidOtherwisePence)}</td>
                        <td className="num">{l.marginPct === null ? <span className="muted">—</span> : `${l.marginPct}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {lines.length >= 400 ? <p className="muted">Showing the latest 400 sales.</p> : null}
              {!lines.length ? <p className="muted">No sales in this period.</p> : null}
            </section>
          ) : null}
        </>
      )}

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Credit vouchers (e.g. CreditYard)</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Trade-in credit taken off at checkout shows in Shopify as a discount, which makes margin look lower than it is. Mark which discounts are really
          credit vouchers: COS then counts them as money received for every brand and category.
        </p>
        {r.discounts.length ? (
          <ul className="attention">
            {r.discounts.map((d) => (
              <li key={d.name}>
                <span>
                  <b>{d.name}</b>
                  <div className="muted">
                    {pounds(d.pence)} across {d.lines} line{d.lines === 1 ? '' : 's'} in this period
                  </div>
                </span>
                <span className="voucher-toggle">
                  {d.voucher ? <span className="verdict star">Credit voucher</span> : <span className="muted">Discount</span>}
                  <ActionButton action={setVoucherAction.bind(null, d.name, !d.voucher)} className="btn small">
                    {d.voucher ? 'It’s a discount' : 'It’s a voucher'}
                  </ActionButton>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Discounts will be listed here once sales have synced from Shopify.</p>
        )}
      </section>
    </>
  );
}
