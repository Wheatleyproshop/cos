import type { ReactNode } from 'react';
import type { Organisation } from '@/db/schema';
import { longDate, money } from '@/lib/format';
import { fitSpec } from '@/lib/fit-spec';
import { PublicShell } from './public-shell';
import { SpecView } from './spec-view';

export type QuoteSummary = {
  quoteNumber: string; brand: string; sku: string; product: string; specificationText: string;
  totalGrossPence: number; depositRequiredPence: number; estimatedLeadTime: string; validUntil: string | null;
  specificationJson?: unknown;
};

/** The customer-facing quote approval page. `action` is the approve form (or a preview notice). */
export function QuoteView({ org, quote: q, customerName, action, banner, previewUrl }: { org: Organisation; quote: QuoteSummary; customerName: string; action: ReactNode; banner?: ReactNode; previewUrl?: string | null }) {
  return (
    <PublicShell org={org}>
      {banner}
      <div className="eyebrow">QUOTE {q.quoteNumber}</div>
      <h1 style={{ fontSize: 26 }}>{previewUrl ? 'Your personalised golf balls' : 'Your personalised quotation'}</h1>
      <p style={{ marginTop: 0 }}>
        Hi {customerName.split(' ')[0]}, please review {previewUrl ? 'your proof and the details' : 'the specification'} below. Approving it places your order with {org.storeName}.
      </p>
      {previewUrl ? (
        <figure className="proof">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={`Preview of your personalised ${q.brand} ${q.product}`} width={900} height={900} />
          <figcaption>Preview for approval. Final print colours and position may vary slightly.</figcaption>
        </figure>
      ) : null}

      {fitSpec(q.specificationJson) ? (
        <div style={{ marginBottom: 14 }}>
          <SpecView json={q.specificationJson} text={q.specificationText} label="Your specification" />
        </div>
      ) : (
        <div className="detailbox" style={{ marginBottom: 14 }}>
          <small>
            {q.brand} {q.sku ? `· ${q.sku}` : ''}
          </small>
          <b style={{ fontSize: 17 }}>{q.product}</b>
          <div style={{ whiteSpace: 'pre-line', marginTop: 8 }}>{q.specificationText}</div>
        </div>
      )}
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
