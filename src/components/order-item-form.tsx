'use client';

import { ITEM_STATUS_LABELS, ITEM_STATUSES, type ItemStatus } from '@/lib/order-items';
import { ActionForm, Submit, type BoundAction } from './forms';

/** One item's status, expected date and supplier reference, saved on its own. */
export function OrderItemForm({ action, label, status, etaDate, supplierReference }: { action: BoundAction; label: string; status: ItemStatus; etaDate: string; supplierReference: string }) {
  return (
    <ActionForm action={action} className="oi-form">
      {(s) => (
        <>
          <label>
            <span className="sr-only">Status of {label}</span>
            <select name="status" defaultValue={status}>
              {ITEM_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {ITEM_STATUS_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Expected date for {label}</span>
            <input type="date" name="etaDate" defaultValue={etaDate} />
          </label>
          <label>
            <span className="sr-only">Supplier reference for {label}</span>
            <input name="supplierReference" defaultValue={supplierReference} placeholder="Supplier ref" maxLength={120} />
          </label>
          <Submit className="btn small">Save</Submit>
          {s?.error ? (
            <span className="error" role="alert">
              {s.error}
            </span>
          ) : s?.message && s.message !== 'Item updated.' ? (
            <span className="oi-msg" role="status">
              {s.message}
            </span>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}
