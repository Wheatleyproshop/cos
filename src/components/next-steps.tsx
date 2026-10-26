import Link from 'next/link';
import {
  closeQuoteAction, prebookStatusAction, quickApproveAction, quickJobAction, quickJobPartsAction, quickMoveAction, quickPlaceAction,
  receiveAllPrebookAction, sendQuoteAction,
} from '@/app/(staff)/actions';
import type { OrderStatus, PrebookStatus, QuoteStatus, WorkshopStatus } from '@/db/schema';
import { money } from '@/lib/format';
import { ArrivedQuick, CollectedQuick, PartsQuick, PlaceQuick, StepQuick } from './board-actions';

/**
 * The one-click "next step" buttons, shared by the order pad, Workshop, Quotes and customer pages,
 * so the same item always offers the same moves (with the same emails) wherever you see it.
 */

export function OrderNextStep({
  o, owed, ready,
}: {
  o: { id: string; orderNumber: string; status: OrderStatus; etaDate: string | null };
  /** Formatted amount still to pay, or null (or payment tracking off). */
  owed: string | null;
  /** Wording for "it's ready" on in-house jobs, e.g. Printed ✓ instead of Arrived ✓. */
  ready?: { text: string; verb: string };
}) {
  if (o.status === 'place_order') return <PlaceQuick action={quickPlaceAction.bind(null, o.id)} defaultEta={o.etaDate ?? ''} label={o.orderNumber} />;
  if (o.status === 'ordered' || o.status === 'delayed') {
    return <ArrivedQuick action={quickMoveAction.bind(null, o.id, 'ready', false)} label={o.orderNumber} text={ready?.text} verb={ready?.verb} />;
  }
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

export function PrebookNextStep({
  p, manager,
}: {
  p: { id: string; reference: string; brand: string; status: PrebookStatus; quantity: number; received: number };
  manager: boolean;
}) {
  const due = p.quantity - p.received;
  const canReceive = ['placed', 'confirmed', 'part_delivered'].includes(p.status) && due > 0;
  if (!(manager && ['draft', 'placed'].includes(p.status)) && !canReceive) return null;
  return (
    <div className="ws-next">
      {manager && p.status === 'draft' ? (
        <StepQuick action={prebookStatusAction.bind(null, p.id, 'placed')} primary confirm={`Mark ${p.reference} (${p.brand}) as placed with the brand?`}>
          Placed ▸
        </StepQuick>
      ) : null}
      {manager && p.status === 'placed' ? (
        <StepQuick action={prebookStatusAction.bind(null, p.id, 'confirmed')} primary>
          Confirmed ✓
        </StepQuick>
      ) : null}
      {canReceive ? (
        <>
          <StepQuick
            action={receiveAllPrebookAction.bind(null, p.id)}
            primary={p.status !== 'placed'}
            confirm={`Book in everything still due on ${p.reference}: ${due} item${due === 1 ? '' : 's'}?`}
          >
            All arrived ✓
          </StepQuick>
          <Link href={`/prebook/${p.reference}#receive`} className="btn small">
            Part delivery…
          </Link>
        </>
      ) : null}
    </div>
  );
}
