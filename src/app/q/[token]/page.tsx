import type { Metadata } from 'next';
import { InvalidLink } from '@/components/public-shell';
import { QuoteView } from '@/components/quote-view';
import { money } from '@/lib/format';
import { proofOf } from '@/lib/proofs';
import { findQuoteByToken, isExpired, proofPathFor } from '@/lib/services/quotes';
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
  const action = closed ? (
    <div className="notice warn">This quote is {q.status}. Please contact the shop if you’d like to go ahead.</div>
  ) : expired ? (
    <div className="notice warn">This quote has expired. Please contact the shop for an updated price.</div>
  ) : (
    <AcceptForm token={token} defaultName={c.name} total={money(q.totalGrossPence)} />
  );
  return <QuoteView org={org} quote={q} customerName={c.name} action={action} previewUrl={proofOf(q.specificationJson) ? proofPathFor(q.id) : null} />;
}
