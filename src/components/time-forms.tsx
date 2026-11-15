'use client';

import { useState } from 'react';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

type Person = { id: string; name: string };

export function AddEntryForm({ action, people, defaultDate, rota }: { action: BoundAction; people: Person[]; defaultDate: string; rota?: boolean }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields entry-fields">
            <Field state={s} name="userId" label="Who" options={[{ value: '', label: 'Choose…' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
            <Field state={s} name="date" label="Date" type="date" defaultValue={defaultDate} />
            <Field state={s} name="start" label="Start" type="time" defaultValue="09:00" />
            <Field state={s} name="end" label={rota ? 'End' : 'Finish'} type="time" defaultValue="17:00" />
            {rota ? null : <Field state={s} name="breakMinutes" label="Unpaid break (mins)" type="number" min="0" defaultValue="0" />}
            <Field state={s} name="note" label="Note" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 6 }}>
            <Submit className="btn">{rota ? '＋ Add to rota' : '＋ Add shift'}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function EditEntry({
  action, values,
}: { action: BoundAction; values: { date: string; start: string; end: string; breakMinutes: number; note: string } }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }
  return (
    <ActionForm action={action}>
      {(s) => (
        <div className="entry-edit">
          <div className="fields entry-fields">
            <Field state={s} name="date" label="Date" type="date" defaultValue={values.date} />
            <Field state={s} name="start" label="Start" type="time" defaultValue={values.start} />
            <Field state={s} name="end" label="Finish" type="time" defaultValue={values.end} hint="Empty = still in" />
            <Field state={s} name="breakMinutes" label="Break (mins)" type="number" min="0" defaultValue={values.breakMinutes} />
            <Field state={s} name="note" label="Reason for change" defaultValue={values.note} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 6 }}>
            <Submit className="btn small">Save</Submit>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </ActionForm>
  );
}
