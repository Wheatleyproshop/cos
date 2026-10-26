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
import { deleteQuoteAction } from '../actions';
import { QuoteNextStep } from '@/components/next-steps';

export const metadata: Metadata = { title: 'Quotes' };

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const status = sp.status === 'closed' || sp.status === 'all' ? sp.status : 'open';
  const [rows, deleted] = await Promise.all([listQuotes(staff.org, { q: sp.q, status }), listDeletedQuotes(staff.organisationId)]);
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
                  </td>
                  <td>
                    {qt.status === 'accepted' && qt.convertedOrderId ? (
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
