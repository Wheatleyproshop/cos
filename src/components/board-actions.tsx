'use client';

import { useActionState, useState } from 'react';
import type { FormState } from '@/lib/action-utils';
import { ActionButton } from './forms';

type FormAction = (prev: FormState, fd: FormData) => Promise<FormState>;

/** "Place" on a To place card: in stock (with the ETA the customer is told) or out of stock. */
export function PlaceQuick({ action, defaultEta, label }: { action: FormAction; defaultEta: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState<'in' | 'out'>('in');
  const [state, formAction, pending] = useActionState(action, null);
  if (!open || state?.ok) {
    return (
      <button type="button" className="btn small primary" onClick={() => setOpen(true)} aria-label={`Place ${label}`}>
        Place ▸
      </button>
    );
  }
  return (
    <form action={formAction} className="quickplace">
      <div className="seg" role="radiogroup" aria-label="Stock at the supplier">
        <button type="button" className={stock === 'in' ? 'on' : ''} aria-pressed={stock === 'in'} onClick={() => setStock('in')}>
          In stock
        </button>
        <button type="button" className={stock === 'out' ? 'on' : ''} aria-pressed={stock === 'out'} onClick={() => setStock('out')}>
          Out of stock
        </button>
      </div>
      <input type="hidden" name="stock" value={stock} />
      <label>
        <span>{stock === 'in' ? 'Arriving' : 'Expected (if known)'}</span>
        <input type="date" name="etaDate" defaultValue={defaultEta} required={stock === 'in'} />
      </label>
      <label>
        <span>Supplier ref (optional)</span>
        <input name="supplierReference" maxLength={120} placeholder="e.g. PING-48192" />
      </label>
      {state?.error ? <span className="error">{state.error}</span> : null}
      <div className="quickplace-actions">
        <button className="btn small primary" type="submit" disabled={pending}>
          {pending ? 'Placing…' : 'Place & email customer'}
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** "Arrived" on a Placed card: ready to collect, customer emailed. */
export function ArrivedQuick({ action, label, text = 'Arrived ✓', verb = 'arrived' }: { action: () => Promise<FormState>; label: string; text?: string; verb?: string }) {
  return (
    <ActionButton action={action} className="btn small primary" confirm={`Mark ${label} as ${verb}? The customer is emailed that it’s ready to collect.`}>
      {text}
    </ActionButton>
  );
}

/** "Collected" on a Ready card. If money is still owed, it says so before closing the order. */
export function CollectedQuick({ action, label, owed }: { action: () => Promise<FormState>; label: string; owed: string | null }) {
  return (
    <ActionButton
      action={action}
      className="btn small"
      confirm={owed ? `${label} still has ${owed} to pay. Mark it collected anyway?` : `Mark ${label} as collected?`}
    >
      Collected ✓
    </ActionButton>
  );
}

/** Workshop: "Waiting for parts" asks what for (the customer sees it in their email). */
export function PartsQuick({ action, label }: { action: FormAction; label: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, null);
  if (!open || state?.ok) {
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)} aria-label={`${label} is waiting for parts`}>
        Waiting for parts
      </button>
    );
  }
  return (
    <form action={formAction} className="quickplace">
      <label>
        <span>What are you waiting for? (the customer sees this)</span>
        <input name="delayReason" required maxLength={300} placeholder="e.g. Golf Pride MCC midsize grips" autoFocus />
      </label>
      {state?.error ? <span className="error">{state.error}</span> : null}
      <div className="quickplace-actions">
        <button className="btn small primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save & email customer'}
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A one-click step (Start, Parts in, Ready, Collected) with an optional confirmation. */
export function StepQuick({ action, children, primary, confirm }: { action: () => Promise<FormState>; children: React.ReactNode; primary?: boolean; confirm?: string }) {
  return (
    <ActionButton action={action} className={`btn small${primary ? ' primary' : ''}`} confirm={confirm}>
      {children}
    </ActionButton>
  );
}
