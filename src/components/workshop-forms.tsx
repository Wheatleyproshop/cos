'use client';

import { useActionState, useEffect, useState } from 'react';
import type { WorkshopStatus } from '@/db/schema';
import type { FormState } from '@/lib/action-utils';
import { money, parseMoneyToPence } from '@/lib/format';
import { CLUB_SUGGESTIONS, WORK_TYPES, WORKSHOP_STATUS_LABELS } from '@/lib/workshop-constants';
import { CustomerPicker, type PickerDefaults } from './customer-picker';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

type Row = { club: string; work: string; parts: string; quantity: string; unitPrice: string };
const blank = (): Row => ({ club: '', work: 'Regrip', parts: '', quantity: '1', unitPrice: '' });
/** Line total in pence: price each × qty. */
const lineTotal = (r: Row) => (parseMoneyToPence(r.unitPrice || '0') ?? 0) * Math.max(1, Number(r.quantity) || 1);

function ClubList() {
  return (
    <datalist id="club-suggestions">
      {CLUB_SUGGESTIONS.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}

/** Check clubs in: customer, one row per club (or set) with the work, parts and price, and a ready date. */
export function CheckInForm({
  action, defaults, defaultEta, canSkipEmail,
}: { action: BoundAction; defaults: PickerDefaults; defaultEta: string; canSkipEmail: boolean }) {
  const [state, formAction, pending] = useActionState(action, null as FormState);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const set = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const total = rows.reduce((s, r) => s + lineTotal(r), 0);
  const filled = rows.filter((r) => r.club.trim() && r.work.trim());
  return (
    <form action={formAction}>
      <ClubList />
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(filled.map(({ unitPrice, ...r }) => ({ ...r, unitPricePence: unitPrice || '0' })))}
      />
      <FormMessage state={state} />
      <div className="fields">
        <CustomerPicker state={state} defaults={defaults} />
      </div>

      <h3 style={{ marginTop: 18 }}>Clubs &amp; work</h3>
      <div className="ws-rows">
        {rows.map((r, i) => (
          <div className="ws-row" key={i}>
            <label className="field">
              <span>Club</span>
              <input list="club-suggestions" value={r.club} onChange={(e) => set(i, 'club', e.target.value)} placeholder="e.g. 7 iron, Driver, Irons 5-PW" maxLength={80} />
            </label>
            <label className="field">
              <span>Work</span>
              <select value={r.work} onChange={(e) => set(i, 'work', e.target.value)}>
                {WORK_TYPES.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Parts / details</span>
              <input value={r.parts} onChange={(e) => set(i, 'parts', e.target.value)} placeholder="e.g. Golf Pride MCC, midsize, +2 wraps" maxLength={160} />
            </label>
            <label className="field ws-qty">
              <span>Qty</span>
              <input type="number" min={1} max={30} value={r.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} />
            </label>
            <label className="field ws-price">
              <span>Price each (£)</span>
              <input inputMode="decimal" value={r.unitPrice} onChange={(e) => set(i, 'unitPrice', e.target.value)} placeholder="0.00" />
            </label>
            <div className="field ws-line" aria-live="polite">
              <span>Total</span>
              <b>{money(lineTotal(r))}</b>
            </div>
            {rows.length > 1 ? (
              <button type="button" className="btn small ws-remove" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                ✕
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <button type="button" className="btn small addclub" onClick={() => setRows((r) => [...r, blank()])}>
        + Add another club
      </button>

      <div className="fields" style={{ marginTop: 16 }}>
        <Field state={state} name="etaDate" label="Estimated ready date" type="date" defaultValue={defaultEta} />
        <Field state={state} name="notes" label="Internal notes" wide textarea placeholder="Not shown to the customer — e.g. bag tag no. 12, customer bringing own grips" />
      </div>
      {canSkipEmail ? (
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" name="skipEmail" /> Don’t email the customer about this check-in
        </label>
      ) : null}
      <div className="spectotal">
        <span>
          {filled.length} club{filled.length === 1 ? '' : 's'} · pay on collection
        </span>
        <b>{money(total)}</b>
      </div>
      <div className="actions">
        <button className="btn primary" type="submit" disabled={pending || !filled.length}>
          {pending ? 'Checking in…' : 'Check in & email customer →'}
        </button>
      </div>
    </form>
  );
}

/** Status, ready date and delay reason. Waiting for parts asks for a reason the customer will see. */
export function WorkshopProgressForm({
  action, status, etaDate, delayReason, canSkipEmail, canCancel,
}: { action: BoundAction; status: WorkshopStatus; etaDate: string | null; delayReason: string; canSkipEmail: boolean; canCancel: boolean }) {
  const [next, setNext] = useState<WorkshopStatus>(status);
  const options = (Object.keys(WORKSHOP_STATUS_LABELS) as WorkshopStatus[]).filter((k) => k !== 'cancelled' || canCancel);
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <label className="field">
              <span>Status</span>
              <select name="status" value={next} onChange={(e) => setNext(e.target.value as WorkshopStatus)}>
                {options.map((k) => (
                  <option key={k} value={k}>
                    {WORKSHOP_STATUS_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <Field state={s} name="etaDate" label="Estimated ready date" type="date" defaultValue={etaDate ?? ''} />
            <Field
              state={s}
              name="delayReason"
              label={next === 'waiting_parts' ? 'What are you waiting for? (customer sees this) *' : 'Note to customer about the date (optional)'}
              wide
              defaultValue={['ready', 'collected', 'cancelled'].includes(status) ? '' : delayReason}
              placeholder={next === 'waiting_parts' ? 'e.g. Waiting for Golf Pride MCC midsize grips to arrive' : 'e.g. Busy week — new date as above'}
            />
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            The customer is emailed when it’s waiting for parts and when it’s ready to collect. Changing the ready date updates their tracking page
            without an email.
          </p>
          {canSkipEmail ? (
            <label className="check">
              <input type="checkbox" name="skipEmail" /> Don’t email the customer about this update
            </label>
          ) : null}
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Update job</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AddWorkshopItemForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <ClubList />
          <div className="fields">
            <label className="field">
              <span>Club *</span>
              <input name="club" list="club-suggestions" required maxLength={80} />
            </label>
            <label className="field">
              <span>Work *</span>
              <select name="work" defaultValue="Regrip">
                {WORK_TYPES.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
            <Field state={s} name="parts" label="Parts / details" />
            <Field state={s} name="quantity" label="Qty" type="number" min="1" defaultValue="1" />
            <Field state={s} name="unitPricePence" label="Price each (£)" inputMode="decimal" placeholder="0.00" hint="Multiplied by the quantity." />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Add club</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** Edit internal notes in place (workshop jobs, quotes). */
export function InternalNotesForm({ action, notes, placeholder }: { action: BoundAction; notes: string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
        {notes ? 'Edit' : 'Add notes'}
      </button>
    );
  }
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <CloseWhenSaved state={s} close={() => setOpen(false)} />
          <label className="field">
            <span className="sr-only">Internal notes</span>
            <textarea name="notes" defaultValue={notes} maxLength={2000} rows={3} placeholder={placeholder ?? 'Not shown to the customer — e.g. bag tag no. 12'} autoFocus />
          </label>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 6 }}>
            <Submit className="btn small">Save notes</Submit>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}

function CloseWhenSaved({ state, close }: { state: FormState; close: () => void }) {
  useEffect(() => {
    if (state?.ok) close();
  }, [state, close]);
  return null;
}
