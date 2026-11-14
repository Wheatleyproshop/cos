'use client';

import { useState } from 'react';
import { WORKSHOP_ITEM_STATUSES, WORKSHOP_ITEM_STATUS_LABELS, type WorkshopItemStatus } from '@/db/schema';
import { ActionForm, Submit, type BoundAction } from './forms';

/** One club's progress on a workshop job, saved on its own. */
export function WorkshopItemForm({ action, label, status }: { action: BoundAction; label: string; status: WorkshopItemStatus }) {
  const [chosen, setChosen] = useState<WorkshopItemStatus>(status);
  return (
    <ActionForm action={action} className="oi-form">
      {(s) => (
        <>
          <label>
            <span className="sr-only">Progress of {label}</span>
            <select name="status" value={chosen} onChange={(e) => setChosen(e.target.value as WorkshopItemStatus)}>
              {WORKSHOP_ITEM_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {WORKSHOP_ITEM_STATUS_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
          {chosen === 'done' && status !== 'done' ? (
            <label className="check oi-email">
              <input type="checkbox" name="emailDone" /> Email the customer that this club is ready
            </label>
          ) : null}
          <Submit className="btn small">Save</Submit>
          {s?.error ? (
            <span className="error" role="alert">
              {s.error}
            </span>
          ) : s?.message && s.message !== 'Club updated.' ? (
            <span className="oi-msg" role="status">
              {s.message}
            </span>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}
