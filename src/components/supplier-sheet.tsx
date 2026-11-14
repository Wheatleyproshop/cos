'use client';

import { useState } from 'react';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

/** Email (opens the shop's own email app, so replies come back to them), copy, and print one supplier's sheet. */
export function SheetButtons({ id, to, subject, body }: { id: string; to: string; subject: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const print = () => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('printing');
    document.documentElement.classList.add('print-one');
    const done = () => {
      el.classList.remove('printing');
      document.documentElement.classList.remove('print-one');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  return (
    <div className="sheet-buttons">
      <a className="btn small primary" href={mailto} title={to ? `Opens an email to ${to}` : 'Add the supplier’s orders email on the Accounts page to fill this in'}>
        ✉ Email {to ? '' : '(no address)'}
      </a>
      <button
        type="button"
        className="btn small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${subject}\n\n${body}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            /* clipboard blocked: the email button still works */
          }
        }}
      >
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
      <button type="button" className="btn small" onClick={print}>
        ⎙ Print
      </button>
    </div>
  );
}

export function MarkPlacedForm({ action, count }: { action: BoundAction; count: number }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <div className="markplaced">
          <div className="fields three" style={{ alignItems: 'end' }}>
            <Field state={s} name="supplierReference" label="Supplier’s order ref (optional)" />
            <Field state={s} name="etaDate" label="Expected (optional)" type="date" />
            <div className="actions" style={{ margin: 0 }}>
              <Submit className="btn" pendingText="Placing…">
                ✓ Mark {count === 1 ? 'it' : `all ${count}`} as placed
              </Submit>
            </div>
          </div>
          <FormMessage state={s} />
        </div>
      )}
    </ActionForm>
  );
}
