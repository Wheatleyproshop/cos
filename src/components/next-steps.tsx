import { closeQuoteAction, quickApproveAction, quickJobAction, quickJobPartsAction, quickMoveAction, quickPlaceAction, sendQuoteAction } from '@/app/(staff)/actions';
import type { OrderStatus, QuoteStatus, WorkshopStatus } from '@/db/schema';
import { money } from '@/lib/format';
import { ArrivedQuick, CollectedQuick, PartsQuick, PlaceQuick, StepQuick } from './board-actions';

/**
 * The one-click "next step" buttons, shared by the order pad, Workshop, Quotes and customer pages,
 * so the same item always offers the same moves (with the same emails) wherever you see it.
 */

export function OrderNextStep({
  o, owed,
}: {
  o: { id: string; orderNumber: string; status: OrderStatus; etaDate: string | null };
  /** Formatted amount still to pay, or null (or payment tracking off). */
  owed: string | null;
}) {
  if (o.status === 'place_order') return <PlaceQuick action={quickPlaceAction.bind(null, o.id)} defaultEta={o.etaDate ?? ''} label={o.orderNumber} />;
  if (o.status === 'ordered' || o.status === 'delayed') return <ArrivedQuick action={quickMoveAction.bind(null, o.id, 'ready', false)} label={o.orderNumber} />;
  if (o.status === 'ready') return <CollectedQuick action={quickMoveAction.bind(null, o.id, 'collected', Boolean(owed))} label={o.orderNumber} owed={owed} />;
  return null;
}

export function QuoteNextStep({
  q, customerName, email,
}: {
  q: { id: string; quoteNumber: string; status: QuoteStatus; totalGrossPence: number };
  customerName: string;
  email: string;
}) {
  if (!['draft', 'sent'].includes(q.status)) return null;
  return (
    <div className="ws-next">
      <StepQuick action={sendQuoteAction.bind(null, q.id)} primary={q.status === 'draft'} confirm={`${q.status === 'draft' ? 'Email' : 'Re-send'} the approval link to ${email}?`}>
        {q.status === 'draft' ? 'Send ▸' : 'Resend'}
      </StepQuick>
      <StepQuick
        action={quickApproveAction.bind(null, q.id)}
        primary={q.status === 'sent'}
        confirm={`Record that ${customerName} approved ${q.quoteNumber} (${money(q.totalGrossPence)})? It becomes an order on the order pad.`}
      >
        Approved ✓
      </StepQuick>
      <StepQuick action={closeQuoteAction.bind(null, q.id, 'declined')} confirm={`Mark ${q.quoteNumber} as declined by ${customerName}?`}>
        Declined
      </StepQuick>
    </div>
  );
}

export function JobNextStep({
  j, customerName,
}: {
  j: { id: string; reference: string; status: WorkshopStatus; totalPence: number };
  customerName: string;
}) {
  const open = ['checked_in', 'in_progress', 'waiting_parts'].includes(j.status);
  if (!open && j.status !== 'ready') return null;
  return (
    <div className="ws-next">
      {j.status === 'checked_in' ? (
        <StepQuick action={quickJobAction.bind(null, j.id, 'in_progress')} primary>
          Start ▸
        </StepQuick>
      ) : null}
      {j.status === 'waiting_parts' ? (
        <StepQuick action={quickJobAction.bind(null, j.id, 'in_progress')} primary>
          Parts in ▸
        </StepQuick>
      ) : null}
      {open ? (
        <StepQuick action={quickJobAction.bind(null, j.id, 'ready')} primary={j.status === 'in_progress'} confirm={`Mark ${j.reference} ready? ${customerName} is emailed to collect.`}>
          Ready ✓
        </StepQuick>
      ) : null}
      {j.status === 'in_progress' || j.status === 'checked_in' ? <PartsQuick action={quickJobPartsAction.bind(null, j.id)} label={j.reference} /> : null}
      {j.status === 'ready' ? (
        <StepQuick
          action={quickJobAction.bind(null, j.id, 'collected')}
          primary
          confirm={`Mark ${j.reference} collected?${j.totalPence ? ` Take ${money(j.totalPence)} at the till.` : ''}`}
        >
          Collected ✓
        </StepQuick>
      ) : null}
    </div>
  );
}
