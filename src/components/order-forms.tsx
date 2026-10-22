'use client';

import { useState } from 'react';
import type { FormState } from '@/lib/action-utils';
import { HANDS, ORDER_CATEGORIES } from '@/lib/order-details';
import { CustomerPicker } from './customer-picker';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

const OTHER = '__other';

/** Brand dropdown (accounts, catalogue, past orders and common brands), with "Other brand…" to type one in. */
export function BrandSelect({ brands, defaultValue = '', state }: { brands: string[]; defaultValue?: string; state: FormState }) {
  const start = String(state?.values?.brand ?? defaultValue ?? '');
  const match = brands.find((b) => b.toLowerCase() === start.toLowerCase());
  const [choice, setChoice] = useState(start ? (match ?? OTHER) : '');
  const [other, setOther] = useState(match ? '' : start);
  const err = state?.fieldErrors?.brand;
  return (
    <>
      <label className={`field${err ? ' invalid' : ''}`}>
        <span>Brand *</span>
        <select name={choice === OTHER ? undefined : 'brand'} value={choice} onChange={(e) => setChoice(e.target.value)} required>
          <option value="">Choose a brand…</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          <option value={OTHER}>Other brand…</option>
        </select>
        {err && choice !== OTHER ? <span className="err">{err}</span> : null}
      </label>
      {choice === OTHER ? (
        <label className={`field${err ? ' invalid' : ''}`}>
          <span>Brand name *</span>
          <input name="brand" value={other} onChange={(e) => setOther(e.target.value)} required maxLength={80} placeholder="Type the brand" autoFocus />
          {err ? <span className="err">{err}</span> : null}
        </label>
      ) : null}
    </>
  );
}

export const CATEGORY_OPTIONS = [{ value: '', label: 'Choose…' }, ...ORDER_CATEGORIES.map((c) => ({ value: c, label: c }))];
const HAND_OPTIONS = HANDS.map((h) => ({ value: h, label: h || 'Not applicable' }));

const METHODS = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'voucher', label: 'Voucher / gift card' },
  { value: 'account', label: 'Member account' },
  { value: 'other', label: 'Other' },
];

export type RequestDefaults = Partial<Record<'customerId' | 'customerName' | 'email' | 'phone' | 'brand' | 'category' | 'product' | 'sku' | 'specificationText', string>>;

export function CreateRequestForm({
  action,
  staffName,
  initialMode,
  defaults,
  cancel,
  brands,
}: {
  action: BoundAction;
  staffName: string;
  canSuppress: boolean;
  initialMode: 'order' | 'quote';
  defaults: RequestDefaults;
  cancel: React.ReactNode;
  brands: string[];
}) {
  const [mode, setMode] = useState(initialMode);
  const quote = mode === 'quote';
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <FormMessage state={s?.error ? s : null} />
          <div className="fields">
            <CustomerPicker state={s} defaults={defaults} />
            <div className="field wide formsection">What they’re ordering</div>
            <BrandSelect brands={brands} defaultValue={defaults.brand} state={s} />
            <Field state={s} name="category" label="Category" options={CATEGORY_OPTIONS} defaultValue={defaults.category ?? ''} />
            <Field state={s} name="product" label="Product" required defaultValue={defaults.product} placeholder="e.g. G440 MAX Driver, Tour Waterproof Jacket" />
            <Field state={s} name="variant" label="Model / variant" placeholder="e.g. 10.5°, Standard fit, 2026 model" />
            <Field state={s} name="colour" label="Colour" placeholder="e.g. Navy / White" />
            <Field state={s} name="size" label="Size" placeholder="e.g. L, UK 9, 34W 31L" />
            <Field state={s} name="hand" label="Hand" options={HAND_OPTIONS} />
            <Field state={s} name="quantity" label="Quantity" type="number" min="1" defaultValue="1" />
            <Field state={s} name="sku" label="Product ID / SKU" defaultValue={defaults.sku} placeholder="Supplier product code" />
            <Field state={s} name="specificationText" label="Specification / other details" wide textarea defaultValue={defaults.specificationText} placeholder="Loft, shaft, flex, length, lie, grip, grip size, wraps… anything the supplier needs" />
            <div className="field wide formsection">Price &amp; payment</div>
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
                <Field
                  state={s}
                  name="creditPence"
                  label="Account credit applied (GBP)"
                  inputMode="decimal"
                  defaultValue="0.00"
                  hint="From the customer’s till account. Reduces the balance owed."
                />
              </>
            )}
            <label className="field">
              <span>Create as</span>
              <select name="mode" value={mode} onChange={(e) => setMode(e.target.value as 'order' | 'quote')}>
                <option value="order">Order (add to the order pad)</option>
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
            ) : (
              <div className="field wide">
                <p className="muted" style={{ margin: 0 }}>
                  The order goes on the order pad as <b>To place</b>. The customer is emailed when you place it with the supplier, with the ETA or
                  an out-of-stock update.
                </p>
              </div>
            )}
          </div>
          <div className="actions">
            {cancel}
            <Submit pendingText="Creating…">{quote ? 'Create quote →' : 'Add to order pad →'}</Submit>
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
  if (order.status === 'place_order') return <PlaceOrderForm action={action} order={order} canSuppress={canSuppress} />;
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
            Changing the ETA, or marking an order Out of stock / delayed, emails the customer an update. Moving to “Ready for collection” sends
            the collection email. “Collected” closes the order.
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
  brands,
}: {
  action: BoundAction;
  values: Record<'brand' | 'category' | 'product' | 'sku' | 'specificationText' | 'total' | 'supplier' | 'supplierNotes' | 'internalNotes', string>;
  brands: string[];
}) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <BrandSelect brands={brands} defaultValue={values.brand} state={s} />
            <Field state={s} name="category" label="Category" options={CATEGORY_OPTIONS} defaultValue={values.category} />
            <Field state={s} name="product" label="Product" required defaultValue={values.product} />
            <Field state={s} name="sku" label="Product ID / SKU" defaultValue={values.sku} />
            <Field state={s} name="totalGrossPence" label="Total price (GBP, incl. VAT)" required inputMode="decimal" defaultValue={values.total} />
            <Field state={s} name="specificationText" label="Specification / details" wide textarea defaultValue={values.specificationText} />
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
    { value: 'credit', label: 'Account credit (till)' },
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

/** Taking an order off the order pad. This is the moment the customer is first emailed. */
function PlaceOrderForm({ action, order, canSuppress }: { action: BoundAction; order: Progress; canSuppress: boolean }) {
  const [stock, setStock] = useState<'ordered' | 'delayed' | 'ready'>('ordered');
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="placechoice" role="radiogroup" aria-label="Stock at the supplier">
            {(
              [
                ['ordered', 'In stock', 'Placed with the supplier, arriving by the date below'],
                ['delayed', 'Out of stock', 'Placed, but on back order at the supplier'],
                ['ready', 'Already in the shop', 'We have it: ready for the customer to collect'],
              ] as const
            ).map(([v, title, sub]) => (
              <label key={v} className={`placeopt${stock === v ? ' on' : ''}`}>
                <input type="radio" name="status" value={v} checked={stock === v} onChange={() => setStock(v)} />
                <b>{title}</b>
                <small>{sub}</small>
              </label>
            ))}
          </div>
          <div className="fields three" style={{ marginTop: 12 }}>
            {stock !== 'ready' ? (
              <>
                <Field
                  state={s}
                  name="etaDate"
                  type="date"
                  label={stock === 'ordered' ? 'Estimated arrival' : 'Expected from the supplier (if known)'}
                  required={stock === 'ordered'}
                  defaultValue={order.etaDate ?? ''}
                />
                <Field state={s} name="supplierReference" label="Supplier order reference" defaultValue={order.supplierReference} placeholder="e.g. PING-48192" />
              </>
            ) : (
              <>
                <input type="hidden" name="etaDate" value={order.etaDate ?? ''} />
                <input type="hidden" name="supplierReference" value={order.supplierReference} />
              </>
            )}
            {stock === 'delayed' ? (
              <Field state={s} wide name="etaReason" label="Note for the customer (optional)" placeholder="e.g. The driver head is on back order with the manufacturer until mid-May." />
            ) : (
              <input type="hidden" name="etaReason" value="" />
            )}
            {canSuppress ? (
              <label className="check wide">
                <input type="checkbox" name="skipEmail" /> Don’t email the customer (manager option)
              </label>
            ) : null}
          </div>
          <div className="notice">
            {stock === 'ordered'
              ? 'The customer gets their order confirmation with this arrival date. After that, they only hear from us if it’s delayed, and when it arrives.'
              : stock === 'delayed'
                ? 'The customer is told it’s placed but out of stock at the supplier. Update the date when the supplier confirms it.'
                : 'The customer is told it’s ready to collect.'}
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>{stock === 'ready' ? 'Mark ready & email customer →' : 'Place order & email customer →'}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
