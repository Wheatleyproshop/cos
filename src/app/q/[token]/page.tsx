import type { Metadata } from 'next';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { longDate, money } from '@/lib/format';
import { findQuoteByToken, isExpired } from '@/lib/services/quotes';
import { AcceptForm } from './accept-form';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Your quotation' }, robots: { index: false } };

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await findQuoteByToken(token);
  if (!d) {
    return (
      <InvalidLink
        title="This approval link is no longer active"
        body="It may already have been approved, or the shop may have sent you a newer link. Please check your latest email or contact the shop."
      />
    );
  }
  const { org, quote: q, customer: c } = d;
  const expired = isExpired(q, org.timezone);
  const closed = !['draft', 'sent'].includes(q.status);

  return (
    <PublicShell org={org}>
      <div className="eyebrow">QUOTE {q.quoteNumber}</div>
      <h1 style={{ fontSize: 26 }}>Your personalised quotation</h1>
      <p style={{ marginTop: 0 }}>Hi {c.name.split(' ')[0]}, please review the specification below. Approving it places your order with {org.storeName}.</p>

      <div className="detailbox" style={{ marginBottom: 14 }}>
        <small>
          {q.brand} {q.sku ? `· ${q.sku}` : ''}
        </small>
        <b style={{ fontSize: 17 }}>{q.product}</b>
        <div style={{ whiteSpace: 'pre-line', marginTop: 8 }}>{q.specificationText}</div>
      </div>
      <div className="detailgrid">
        <div className="detailbox">
          <small>Price (incl. VAT)</small>
          <b>{money(q.totalGrossPence)}</b>
        </div>
        <div className="detailbox">
          <small>Deposit to proceed</small>
          <b>{q.depositRequiredPence ? money(q.depositRequiredPence) : 'None'}</b>
          {q.depositRequiredPence ? <div className="muted">Payable to the shop to place the order</div> : null}
        </div>
        <div className="detailbox">
          <small>Estimated lead time</small>
          <b>{q.estimatedLeadTime || 'Confirmed on order'}</b>
        </div>
        <div className="detailbox">
          <small>Quote valid until</small>
          <b>{q.validUntil ? longDate(q.validUntil) : 'Open'}</b>
        </div>
      </div>

      {org.quoteTerms ? (
        <>
          <h3>Terms</h3>
          <p style={{ whiteSpace: 'pre-line', fontSize: 13 }}>{org.quoteTerms}</p>
        </>
      ) : null}

      {closed ? (
        <div className="notice warn">This quote is {q.status}. Please contact the shop if you’d like to go ahead.</div>
      ) : expired ? (
        <div className="notice warn">This quote has expired. Please contact the shop for an updated price.</div>
      ) : (
        <AcceptForm token={token} defaultName={c.name} total={money(q.totalGrossPence)} />
      )}
    </PublicShell>
  );
}
