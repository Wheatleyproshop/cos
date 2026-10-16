import type { ReactNode } from 'react';
import type { Organisation } from '@/db/schema';
import { longDate, money } from '@/lib/format';
import { PublicShell } from './public-shell';

export type QuoteSummary = {
  quoteNumber: string; brand: string; sku: string; product: string; specificationText: string;
  totalGrossPence: number; depositRequiredPence: number; estimatedLeadTime: string; validUntil: string | null;
};

/** The customer-facing quote approval page. `action` is the approve form (or a preview notice). */
export function QuoteView({ org, quote: q, customerName, action, banner }: { org: Organisation; quote: QuoteSummary; customerName: string; action: ReactNode; banner?: ReactNode }) {
  return (
    <PublicShell org={org}>
      {banner}
      <div className="eyebrow">QUOTE {q.quoteNumber}</div>
      <h1 style={{ fontSize: 26 }}>Your personalised quotation</h1>
      <p style={{ marginTop: 0 }}>Hi {customerName.split(' ')[0]}, please review the specification below. Approving it places your order with {org.storeName}.</p>

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

      {action}
    </PublicShell>
  );
}
