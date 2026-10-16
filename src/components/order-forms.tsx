'use client';

import { useState } from 'react';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

const METHODS = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'voucher', label: 'Voucher / gift card' },
  { value: 'account', label: 'Member account' },
  { value: 'other', label: 'Other' },
];

export type RequestDefaults = Partial<Record<'customerName' | 'email' | 'phone' | 'brand' | 'product' | 'sku' | 'specificationText', string>>;

export function CreateRequestForm({
  action,
  staffName,
  canSuppress,
  initialMode,
  defaults,
  cancel,
}: {
  action: BoundAction;
  staffName: string;
  canSuppress: boolean;
  initialMode: 'order' | 'quote';
  defaults: RequestDefaults;
  cancel: React.ReactNode;
}) {
  const [mode, setMode] = useState(initialMode);
  const quote = mode === 'quote';
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <FormMessage state={s?.error ? s : null} />
          <div className="fields">
            <Field state={s} name="customerName" label="Customer name" required defaultValue={defaults.customerName} placeholder="Full name" autoComplete="off" />
            <Field state={s} name="email" label="Email address" type="email" required defaultValue={defaults.email} placeholder="customer@example.com" autoComplete="off" />
            <Field state={s} name="phone" label="Phone" type="tel" defaultValue={defaults.phone} placeholder="Mobile number" inputMode="tel" />
            <Field state={s} name="brand" label="Brand" required defaultValue={defaults.brand} placeholder="e.g. PING" />
            <Field state={s} name="product" label="Product" required defaultValue={defaults.product} placeholder="e.g. G440 MAX Driver" />
            <Field state={s} name="sku" label="Product ID / SKU" defaultValue={defaults.sku} placeholder="Supplier product code" />
            <Field state={s} name="specificationText" label="Custom specification" required wide textarea defaultValue={defaults.specificationText} placeholder="Loft, shaft, flex, length, lie, grip, grip size, wraps, colour, size…" />
            <Field state={s} name="totalGrossPence" label="Total price (GBP, incl. VAT)" required inputMode="decimal" placeholder="0.00" />
            {quote ? (
              <>
                <Field state={s} name="depositRequiredPence" label="Deposit required to proceed (GBP)" inputMode="decimal" defaultValue="0.00" />
                <Field state={s} name="estimatedLeadTime" label="Estimated lead time" placeholder="e.g. 2–3 weeks" />
                <Field state={s} name="validUntil" label="Quote valid until" type="date" />
              </>
            ) : (
              <>
                <Field state={s} name="depositPence" label="Deposit received (GBP)" inputMode="decimal" defaultValue="0.00" />
                <Field state={s} name="depositMethod" label="Deposit paid by" options={METHODS} />
                <Field state={s} name="etaDate" label="Estimated arrival" type="date" />
                <Field state={s} name="supplierReference" label="Supplier order reference" placeholder="e.g. PING-48192" />
              </>
            )}
            <label className="field">
              <span>Create as</span>
              <select name="mode" value={mode} onChange={(e) => setMode(e.target.value as 'order' | 'quote')}>
                <option value="order">Place order</option>
                <option value="quote">Quote (customer approves online)</option>
              </select>
            </label>
            <label className="field">
              <span>Order taken by</span>
              <input readOnly value={`${staffName} (you)`} aria-describedby="taken-hint" />
            </label>
            <Field state={s} name="internalNotes" label="Internal notes" wide textarea placeholder="Special instructions, supplier notes, customer requests… (never shown to the customer)" />
            <div className="field wide">
              <div className="notice" style={{ margin: 0 }} id="taken-hint">
                <b>Automatic audit record</b>
                COS will permanently record you as the staff member who took this {quote ? 'quote' : 'order'}, with the exact date and time. Future
                changes are also attributed and time-stamped.
              </div>
            </div>
            {quote ? (
              <label className="check wide">
                <input type="checkbox" name="sendNow" defaultChecked /> Email the customer a secure approval link now
              </label>
            ) : canSuppress ? (
              <label className="check wide">
                <input type="checkbox" name="skipEmail" /> Don’t send the order confirmation email (manager option)
              </label>
            ) : null}
          </div>
          <div className="actions">
            {cancel}
            <Submit pendingText="Creating…">{quote ? 'Create quote →' : 'Create & queue confirmation →'}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

type Progress = { status: string; etaDate: string | null; etaReason: string; supplierReference: string };

export function ProgressForm({
  action,
  order,
  options,
  canSuppress,
  balanceText,
  hasBalance,
}: {
  action: BoundAction;
  order: Progress;
  options: { value: string; label: string }[];
  canSuppress: boolean;
  balanceText: string;
  hasBalance: boolean;
}) {
  const [status, setStatus] = useState(order.status);
  const [eta, setEta] = useState(order.etaDate ?? '');
  const etaChanging = eta !== (order.etaDate ?? '');
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields three">
            <label className={`field${s?.fieldErrors?.status ? ' invalid' : ''}`}>
              <span>Update status</span>
              <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {s?.fieldErrors?.status ? <span className="err">{s.fieldErrors.status}</span> : null}
            </label>
            <label className="field">
              <span>Revise ETA</span>
              <input type="date" name="etaDate" value={eta} onChange={(e) => setEta(e.target.value)} />
            </label>
            <Field state={s} name="supplierReference" label="Supplier reference" defaultValue={order.supplierReference} placeholder="Not added" />
            {etaChanging || status === 'delayed' ? (
              <Field
                state={s}
                wide
                name="etaReason"
                label="Reason shown to the customer (optional)"
                defaultValue={order.etaReason}
                placeholder="e.g. The manufacturer has told us the shaft is on back order."
              />
            ) : (
              <input type="hidden" name="etaReason" value={order.etaReason} />
            )}
            {status === 'collected' && hasBalance ? (
              <label className={`check wide${s?.fieldErrors?.collectWithBalance ? ' invalid' : ''}`}>
                <input type="checkbox" name="collectWithBalance" /> Customer is collecting with {balanceText} still outstanding
              </label>
            ) : null}
            {canSuppress ? (
              <label className="check wide">
                <input type="checkbox" name="skipEmail" /> Don’t email the customer about this change
              </label>
            ) : null}
          </div>
          <div className="notice">
            Changing the ETA, or marking an order Delayed, emails the customer an update. Moving to “Ready for collection” sends the
            collection email. “Collected” closes the order.
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save changes →</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function EditOrderForm({
  action,
  values,
}: {
  action: BoundAction;
  values: Record<'brand' | 'product' | 'sku' | 'specificationText' | 'total' | 'supplier' | 'supplierNotes' | 'internalNotes', string>;
}) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="brand" label="Brand" required defaultValue={values.brand} />
            <Field state={s} name="product" label="Product" required defaultValue={values.product} />
            <Field state={s} name="sku" label="Product ID / SKU" defaultValue={values.sku} />
            <Field state={s} name="totalGrossPence" label="Total price (GBP, incl. VAT)" required inputMode="decimal" defaultValue={values.total} />
            <Field state={s} name="specificationText" label="Custom specification" required wide textarea defaultValue={values.specificationText} />
            <Field state={s} name="supplier" label="Supplier" defaultValue={values.supplier} />
            <Field state={s} name="supplierNotes" label="Supplier notes (staff only)" defaultValue={values.supplierNotes} />
            <Field state={s} name="internalNotes" label="Internal notes (staff only)" wide textarea defaultValue={values.internalNotes} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save details</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PaymentForm({ action, canRefund }: { action: BoundAction; canRefund: boolean }) {
  const kinds = [
    { value: 'payment', label: 'Payment' },
    { value: 'deposit', label: 'Deposit' },
    ...(canRefund ? [{ value: 'refund', label: 'Refund / correction' }] : []),
  ];
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="inline-form">
            <Field state={s} name="kind" label="Type" options={kinds} />
            <Field state={s} name="amountPence" label="Amount (GBP)" required inputMode="decimal" placeholder="0.00" />
            <Field state={s} name="method" label="Method" options={METHODS} />
            <Field state={s} name="reference" label="Reference" placeholder="Till / receipt no." />
            <Submit className="btn" pendingText="Recording…">
              Record payment
            </Submit>
          </div>
          <FormMessage state={s} />
        </>
      )}
    </ActionForm>
  );
}

export function NoteForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="inline-form">
            <Field state={s} name="note" label="Add an internal note" required placeholder="e.g. Customer called — happy to wait for stock" />
            <Submit className="btn" pendingText="Adding…">
              Add note
            </Submit>
          </div>
          {s?.error ? <FormMessage state={s} /> : null}
        </>
      )}
    </ActionForm>
  );
}

export function AttachmentForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="inline-form">
            <label className={`field${s?.fieldErrors?.file ? ' invalid' : ''}`} style={{ flexBasis: 220 }}>
              <span>File (PDF, image, Word, Excel · max 4 MB)</span>
              <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.gif,.txt,.csv,.xlsx,.docx" />
              {s?.fieldErrors?.file ? <span className="err">{s.fieldErrors.file}</span> : null}
            </label>
            <Field
              state={s}
              name="category"
              label="Type"
              options={[
                { value: 'supplier_confirmation', label: 'Supplier confirmation' },
                { value: 'fitting_sheet', label: 'Fitting sheet' },
                { value: 'invoice', label: 'Invoice' },
                { value: 'product_photo', label: 'Product photo' },
                { value: 'screenshot', label: 'Screenshot' },
                { value: 'other', label: 'Other' },
              ]}
            />
            <Field
              state={s}
              name="visibility"
              label="Visible to"
              options={[
                { value: 'internal', label: 'Staff only' },
                { value: 'customer-visible', label: 'Staff + customer tracking page' },
              ]}
            />
            <Submit className="btn" pendingText="Uploading…">
              Upload
            </Submit>
          </div>
          <FormMessage state={s} />
        </>
      )}
    </ActionForm>
  );
}
