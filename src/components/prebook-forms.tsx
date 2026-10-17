'use client';

import type { PrebookLine } from '@/db/schema';
import { money } from '@/lib/format';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

type AccountValues = {
  brand?: string; accountNumber?: string; repName?: string; repPhone?: string; repEmail?: string; headOfficePhone?: string;
  headOfficeEmail?: string; ordersEmail?: string; portalUrl?: string; portalUsername?: string; paymentTerms?: string; notes?: string;
};

/** A brand's trade account. Deliberately no password field — those belong in a password manager. */
export function AccountForm({ action, values = {}, submitLabel = 'Save' }: { action: BoundAction; values?: AccountValues; submitLabel?: string }) {
  return (
    <ActionForm action={action} resetOnSuccess={!values.brand}>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="brand" label="Brand" required defaultValue={values.brand} placeholder="e.g. Titleist" />
            <Field state={s} name="accountNumber" label="Account number" defaultValue={values.accountNumber} />
            <Field state={s} name="repName" label="Rep name" defaultValue={values.repName} />
            <Field state={s} name="repPhone" label="Rep mobile" type="tel" defaultValue={values.repPhone} />
            <Field state={s} name="repEmail" label="Rep email" type="email" defaultValue={values.repEmail} />
            <Field state={s} name="headOfficePhone" label="Head office phone" type="tel" defaultValue={values.headOfficePhone} />
            <Field state={s} name="headOfficeEmail" label="Head office email" type="email" defaultValue={values.headOfficeEmail} />
            <Field state={s} name="ordersEmail" label="Orders / customer services email" type="email" defaultValue={values.ordersEmail} />
            <Field state={s} name="portalUrl" label="Trade portal (B2B) website" defaultValue={values.portalUrl} placeholder="https://" />
            <Field state={s} name="portalUsername" label="Portal username" defaultValue={values.portalUsername} hint="Keep passwords in a password manager, not here." />
            <Field state={s} name="paymentTerms" label="Payment terms" defaultValue={values.paymentTerms} placeholder="e.g. 30 days end of month, 2.5% settlement" />
            <Field state={s} name="notes" label="Notes" wide textarea defaultValue={values.notes} placeholder="Pre-book deadlines, delivery days, carriage paid threshold…" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>{submitLabel}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

type Opt = { value: string; label: string };
type PrebookValues = {
  supplierAccountId?: string | null; brand?: string; season?: string; title?: string; supplierReference?: string;
  expectedFrom?: string | null; expectedTo?: string | null; notes?: string;
};

export function PrebookDetailsForm({ action, accounts, values = {}, submitLabel }: { action: BoundAction; accounts: Opt[]; values?: PrebookValues; submitLabel: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field
              state={s}
              name="supplierAccountId"
              label="Brand account"
              options={[{ value: '', label: accounts.length ? 'Choose…' : 'No accounts yet — type the brand below' }, ...accounts]}
              defaultValue={values.supplierAccountId ?? ''}
            />
            <Field state={s} name="brand" label="…or brand (if no account)" defaultValue={values.supplierAccountId ? '' : values.brand} />
            <Field state={s} name="season" label="Season" defaultValue={values.season} placeholder="e.g. 2027 or SS27" />
            <Field state={s} name="title" label="Description" defaultValue={values.title} placeholder="e.g. Spring launch: GTS drivers & T-Series" />
            <Field state={s} name="supplierReference" label="Supplier order reference" defaultValue={values.supplierReference} />
            <Field state={s} name="expectedFrom" label="Delivery expected from" type="date" defaultValue={values.expectedFrom ?? ''} />
            <Field state={s} name="expectedTo" label="Delivery expected by" type="date" defaultValue={values.expectedTo ?? ''} />
            <Field state={s} name="notes" label="Notes" wide textarea defaultValue={values.notes} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>{submitLabel}</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PrebookLineForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="product" label="Product" required placeholder="e.g. GTS2 Driver" />
            <Field state={s} name="variant" label="Variant" placeholder="e.g. 9° / Tensei Blue 55 / Stiff / RH" />
            <Field state={s} name="sku" label="SKU" />
            <Field state={s} name="quantity" label="Quantity" type="number" min="1" required defaultValue="1" />
            <Field state={s} name="unitCostPence" label="Unit cost (GBP, trade)" inputMode="decimal" placeholder="0.00" />
            <Field state={s} name="expectedDate" label="Expected (if different)" type="date" />
            <Field state={s} name="forCustomer" label="For customer (optional)" wide placeholder="e.g. Reserved for J. Smith" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Add line</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** Lines with a "received so far" box each; saving books the arrivals in. */
export function ReceiveForm({
  action, lines, canReceive, removeButtons,
}: { action: BoundAction; lines: PrebookLine[]; canReceive: boolean; removeButtons?: Record<string, React.ReactNode> }) {
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
  const totalVal = lines.reduce((s, l) => s + l.quantity * l.unitCostPence, 0);
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="tablewrap">
            <table className="compact pblines">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit cost</th>
                  <th className="num">Value</th>
                  <th>Expected</th>
                  <th className="num">Received</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className={l.quantityReceived >= l.quantity ? 'pb-done' : ''}>
                    <td>
                      <b>{l.product}</b>
                      {l.variant ? <div className="muted">{l.variant}</div> : null}
                      {l.sku ? <div className="muted">SKU {l.sku}</div> : null}
                      {l.forCustomer ? <div className="pb-for">For: {l.forCustomer}</div> : null}
                    </td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{money(l.unitCostPence)}</td>
                    <td className="num">{money(l.unitCostPence * l.quantity)}</td>
                    <td>{l.expectedDate ? new Date(`${l.expectedDate}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                    <td className="num">
                      {canReceive ? (
                        <input
                          name={`received:${l.id}`}
                          type="number"
                          min={0}
                          max={l.quantity}
                          defaultValue={l.quantityReceived}
                          aria-label={`Received of ${l.product}`}
                          className="pb-recv"
                        />
                      ) : (
                        `${l.quantityReceived} / ${l.quantity}`
                      )}
                    </td>
                    <td className="num">{removeButtons?.[l.id]}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="num">{totalQty}</th>
                  <th />
                  <th className="num">{money(totalVal)}</th>
                  <th colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
          <FormMessage state={s} />
          {canReceive && lines.length ? (
            <div className="actions" style={{ marginTop: 10 }}>
              <Submit>Save deliveries</Submit>
            </div>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}

/** Upload or replace a brand logo; submits as soon as a file is picked. */
export function AccountLogoForm({ action, hasLogo }: { action: BoundAction; hasLogo: boolean }) {
  return (
    <ActionForm action={action} className="inlineform" encType="multipart/form-data">
      {(s) => (
        <>
          <label className="btn small">
            {hasLogo ? 'Replace logo' : 'Add logo'}
            <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.currentTarget.form?.requestSubmit()} />
          </label>
          {s?.error ? <span className="error">{s.error}</span> : null}
        </>
      )}
    </ActionForm>
  );
}
