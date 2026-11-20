import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { RowLink, SearchBox } from '@/components/chrome';
import { Badge, PageHeader } from '@/components/views';
import { ActionButton } from '@/components/forms';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, niceDate, stamp } from '@/lib/format';
import { listQuotes } from '@/lib/queries';
import { listDeletedQuotes } from '@/lib/services/quotes';
import { QUOTE_STATUS_LABELS } from '@/lib/status';
import { deleteQuoteAction, orderRequestLinkAction } from '../actions';
import { CopyLink } from '@/components/copy-link';
import { listOpenRequests } from '@/lib/services/order-requests';
import { appUrl } from '@/lib/tokens';
import { QuoteNextStep } from '@/components/next-steps';
import { awaitingPayment, payStatesForQuotes, UNPAID_FLAG_DAYS } from '@/lib/services/shopify-invoices';

export const metadata: Metadata = { title: 'Quotes' };

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const status = sp.status === 'closed' || sp.status === 'all' ? sp.status : 'open';
  const [rows, deleted, requests] = await Promise.all([
    listQuotes(staff.org, { q: sp.q, status }),
    listDeletedQuotes(staff.organisationId),
    listOpenRequests(staff.organisationId),
  ]);
  const [pay, unpaid] = await Promise.all([payStatesForQuotes(staff.organisationId, rows.map((r) => r.quote.id)), awaitingPayment(staff.organisationId)]);
  const requestOn = staff.org.orderRequestLink;
  const manager = hasRole(staff, 'manager');
  const tz = staff.org.timezone;
  return (
    <>
      <PageHeader
        staff={staff}
        title="Customer quotes."
        sub="Turn approved quotes into orders in one click."
        actions={
          <Link href="/orders/new?mode=quote" className="btn primary" scroll={false}>
            ＋ &nbsp; New quote
          </Link>
        }
      />
      <section className="panel requests-panel" aria-labelledby="web-requests">
        <div className="panel-head">
          <h2 id="web-requests">Website special order requests</h2>
          <span className={`badge ${requestOn ? 'ready' : 'pb-cancelled'}`}>{requestOn ? 'On' : 'Off'}</span>
        </div>
        {requests.length ? (
          <ul className="attention">
            {requests.map((r) => {
              const spec = r.spec as { neededBy?: string; budget?: string } | null;
              return (
                <li key={r.quoteNumber}>
                  <span>
                    <Link href={`/quotes/${r.quoteNumber}`} className="rowtitle">
                      {r.quoteNumber} · {r.customer}
                    </Link>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {r.brand} {r.product}
                    </span>
                  </span>
                  <span className="muted">
                    {[spec?.neededBy, spec?.budget && `budget ${spec.budget}`, `sent ${stamp(r.createdAt, tz)}`].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            {requestOn
              ? 'Customers ask for something you don’t stock and it arrives here as a draft quote to price and send. Link to it from your website, e.g. a “Special orders” menu item.'
              : 'Switched off: customers who open the link are asked to contact the shop.'}
          </p>
        )}
        {requestOn ? <CopyLink url={appUrl(`/request/${staff.org.slug}`)} label="Special order request page" /> : null}
        {manager ? (
          <div style={{ marginTop: 10 }}>
            <ActionButton action={orderRequestLinkAction.bind(null, !requestOn)} className="btn small">
              {requestOn ? 'Switch page off' : 'Switch page on'}
            </ActionButton>
          </div>
        ) : null}
      </section>
      {unpaid.length ? (
        <section className="panel" aria-labelledby="awaiting-payment">
          <div className="panel-head">
            <h2 id="awaiting-payment">Awaiting payment (Shopify invoices)</h2>
            <span className="badge">{unpaid.length}</span>
          </div>
          <ul className="attention">
            {unpaid.map((u) => (
              <li key={u.invoiceId}>
                <span>
                  <Link href={`/quotes/${u.quoteNumbers[0]}`} className="rowtitle">
                    {u.quoteNumbers.join(', ')} · {u.customer}
                  </Link>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {u.draftOrderName} · {money(u.totalPence)}
                  </span>
                  {u.overdue ? <span className="flag">Unpaid over {UNPAID_FLAG_DAYS} days</span> : null}
                </span>
                <span className="muted">sent {u.sentAt ? stamp(u.sentAt, tz) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="toolbar">
        <Suspense>
          <SearchBox placeholder="Search quotes by customer, email, phone, quote ID, brand, product or SKU…" />
        </Suspense>
      </div>
      <nav className="pills" aria-label="Filter quotes">
        {[
          ['open', 'Open'],
          ['closed', 'Accepted / closed'],
          ['all', 'All'],
        ].map(([k, label]) => (
          <Link key={k} href={`/quotes?status=${k}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`} className={`pill${status === k ? ' selected' : ''}`}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>Quote / Product</th>
              <th>Customer</th>
              <th>Price</th>
              <th>Created</th>
              <th>Status</th>
              <th>Next step</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map(({ quote: qt, customer: c, createdByName, flags }) => (
                <RowLink key={qt.id} href={`/quotes/${qt.quoteNumber}`}>
                  <td>
                    <Link href={`/quotes/${qt.quoteNumber}`} className="rowtitle" scroll={false}>
                      {qt.brand} {qt.product}
                    </Link>
                    <div className="muted">
                      {qt.quoteNumber}
                      {qt.validUntil ? ` · valid to ${niceDate(qt.validUntil)}` : ''}
                    </div>
                    {flags.map((f) => (
                      <span key={f.code} className="flag">
                        {f.label}
                      </span>
                    ))}
                  </td>
                  <td>
                    {c.name}
                    <div className="muted">{c.email}</div>
                  </td>
                  <td>
                    <b>{money(qt.totalGrossPence)}</b>
                  </td>
                  <td>
                    {stamp(qt.createdAt, tz)}
                    <div className="muted">by {createdByName}</div>
                  </td>
                  <td>
                    <Badge status="quote" text={QUOTE_STATUS_LABELS[qt.status]} />
                    {pay.get(qt.id) ? (
                      <div>
                        <span className={pay.get(qt.id)!.status === 'paid' ? 'badge ready' : pay.get(qt.id)!.overdue ? 'flag' : 'badge'}>{pay.get(qt.id)!.label}</span>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {pay.get(qt.id)?.status === 'awaiting_payment' ? (
                      <span className="muted">Waiting for the customer to pay the Shopify invoice</span>
                    ) : qt.status === 'accepted' && qt.convertedOrderId ? (
                      <span className="muted">Now an order</span>
                    ) : (
                      <QuoteNextStep q={qt} customerName={c.name} email={c.email} />
                    )}
                  </td>
                </RowLink>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  No quotes here. <Link href="/orders/new?mode=quote">Create a quote</Link> and the customer can approve it online.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {deleted.length ? (
        <section className="panel" style={{ marginTop: 18 }}>
          <details className="section">
            <summary>Deleted quotes ({deleted.length})</summary>
            <ul className="attention">
              {deleted.map((d) => (
                <li key={d.id}>
                  <span>
                    <Link href={`/quotes/${d.quoteNumber}`} className="rowtitle" scroll={false}>
                      {d.quoteNumber} · {d.customer}
                    </Link>
                    <div className="muted">
                      {d.brand} {d.product} · deleted {stamp(d.archivedAt!, tz)}
                    </div>
                  </span>
                  {hasRole(staff, 'manager') ? (
                    <ActionButton action={deleteQuoteAction.bind(null, d.id, false)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </>
  );
}
