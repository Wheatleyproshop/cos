'use client';

import { useTransition, useState } from 'react';
import type { FormState } from '@/lib/action-utils';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';
import { BrandSelect, CATEGORY_OPTIONS } from './order-forms';

/* ── Quotes ──────────────────────────────────────────────────────────── */

export function EditQuoteForm({ action, values, brands }: { action: BoundAction; values: Record<string, string>; brands: string[] }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <BrandSelect brands={brands} defaultValue={values.brand} state={s} />
            <Field state={s} name="category" label="Category" options={CATEGORY_OPTIONS} defaultValue={values.category ?? ''} />
            <Field state={s} name="product" label="Product" required defaultValue={values.product} />
            <Field state={s} name="sku" label="Product ID / SKU" defaultValue={values.sku} />
            <Field state={s} name="totalGrossPence" label="Price (GBP, incl. VAT)" required inputMode="decimal" defaultValue={values.total} />
            <Field state={s} name="specificationText" label="Specification / details" wide textarea defaultValue={values.specificationText} />
            <Field state={s} name="depositRequiredPence" label="Deposit required (GBP)" inputMode="decimal" defaultValue={values.deposit} />
            <Field state={s} name="estimatedLeadTime" label="Estimated lead time" defaultValue={values.estimatedLeadTime} />
            <Field state={s} name="validUntil" label="Valid until" type="date" defaultValue={values.validUntil} />
            <Field state={s} name="internalNotes" label="Internal notes (staff only)" textarea defaultValue={values.internalNotes} />
          </div>
          <div className="notice warn">If the customer already has the link, they will see the updated quote when they open it.</div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save quote</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AcceptInStoreForm({ action, defaultName }: { action: BoundAction; defaultName: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="inline-form">
            <Field state={s} name="acceptedName" label="Approved by (customer name)" required defaultValue={defaultName} />
            <Submit className="btn primary" pendingText="Converting…">
              Record approval & create order →
            </Submit>
          </div>
          <div className="muted">Use when the customer approves in person or by phone. The order is created from this quote with no re-keying.</div>
          <FormMessage state={s} />
        </>
      )}
    </ActionForm>
  );
}

/* ── Customers ───────────────────────────────────────────────────────── */

export function CustomerForm({ action, values }: { action: BoundAction; values: Record<string, string> }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="name" label="Name" required defaultValue={values.name} />
            <Field state={s} name="email" label="Email" type="email" defaultValue={values.email} />
            <Field state={s} name="phone" label="Phone" type="tel" defaultValue={values.phone} />
            <Field state={s} name="notes" label="Customer notes (staff only)" textarea defaultValue={values.notes} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save customer</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/* ── Settings ────────────────────────────────────────────────────────── */

export function StoreForm({ action, values, disabled }: { action: BoundAction; values: Record<string, string>; disabled: boolean }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="fields">
            <Field state={s} name="storeName" label="Store name" required defaultValue={values.storeName} hint="Appears as the email sender name and on customer pages" />
            <Field state={s} name="replyToEmail" label="Reply-to email" type="email" required defaultValue={values.replyToEmail} hint="Customer replies go here" />
            <Field
              state={s}
              name="senderEmail"
              label="Send customer emails from (optional)"
              type="email"
              wide
              defaultValue={values.senderEmail}
              placeholder="e.g. orders@yourshop.co.uk"
              hint={values.senderHint}
            />
            <Field state={s} name="collectionLocation" label="Collection location" wide defaultValue={values.collectionLocation} />
            <Field state={s} name="storePhone" label="Store phone" type="tel" defaultValue={values.storePhone} />
            <Field state={s} name="openingHours" label="Opening hours" defaultValue={values.openingHours} placeholder="e.g. Mon–Sun 8am–6pm" />
            <div className="field wide">
              <b style={{ fontSize: 13, color: 'var(--ink)' }}>Customer email & page branding</b>
              <span className="hint">Match your own website. Used on every customer email, quote approval and tracking page.</span>
            </div>
            <Field
              state={s}
              name="logoUrl"
              label="Logo image link"
              wide
              defaultValue={values.logoUrl}
              placeholder="https://www.yourshop.co.uk/…/logo.png"
              hint="A PNG on a transparent background works best. Leave blank to show your store name instead."
            />
            <Field state={s} name="websiteUrl" label="Your website" defaultValue={values.websiteUrl} placeholder="https://www.yourshop.co.uk" />
            <Field
              state={s}
              name="headingFont"
              label="Heading font"
              defaultValue={values.headingFont}
              options={[
                { value: 'barlow', label: 'Barlow (modern sans)' },
                { value: 'inter', label: 'Inter (clean sans)' },
                { value: 'georgia', label: 'Georgia (classic serif)' },
                { value: 'system', label: 'System default' },
              ]}
            />
            <div className="field wide">
              <div className="fields three">
                <label className="field">
                  <span>Header colour</span>
                  <input type="color" name="brandColor" defaultValue={values.brandColor} style={{ height: 46, padding: 6 }} />
                </label>
                <label className="field">
                  <span>Header text colour</span>
                  <input type="color" name="headerTextColor" defaultValue={values.headerTextColor} style={{ height: 46, padding: 6 }} />
                </label>
                <label className="field">
                  <span>Button & accent colour</span>
                  <input type="color" name="accentColor" defaultValue={values.accentColor} style={{ height: 46, padding: 6 }} />
                </label>
              </div>
            </div>
            <label className="check wide">
              <input type="checkbox" name="squareButtons" defaultChecked={values.squareButtons === 'true'} /> Square-cornered buttons
            </label>
            <Field state={s} name="quoteTerms" label="Quote terms shown to customers" wide textarea defaultValue={values.quoteTerms} />
          </div>
          <FormMessage state={s} />
          {!disabled ? (
            <div className="actions">
              <Submit>Save branding</Submit>
            </div>
          ) : null}
        </fieldset>
      )}
    </ActionForm>
  );
}

const AUTOMATIONS: { key: string; label: string; detail: string }[] = [
  { key: 'order_confirmation', label: 'Order confirmation', detail: 'When an order is created or a quote is accepted' },
  { key: 'quote_approval', label: 'Quote approval', detail: 'When staff send a quote for approval' },
  { key: 'eta_revised', label: 'ETA changed / delayed', detail: 'When the estimated arrival changes or an order is delayed' },
  { key: 'ready_for_collection', label: 'Ready for collection', detail: 'When an order is marked ready' },
  { key: 'collection_reminder', label: 'Collection reminder', detail: 'Daily check for orders ready but not collected' },
  { key: 'workshop_checked_in', label: 'Workshop: clubs checked in', detail: 'When clubs are checked in for repair or regripping' },
  { key: 'workshop_delayed', label: 'Workshop: delay update', detail: 'When a workshop job is waiting for parts or its ready date changes' },
  { key: 'workshop_ready', label: 'Workshop: ready to collect', detail: 'When a workshop job is marked ready' },
  { key: 'workshop_reminder', label: 'Workshop: collection reminder', detail: 'Daily check for workshop jobs ready but not collected' },
  { key: 'ball_design_received', label: 'Online design received', detail: 'When a customer sends in their own golf ball or cresting design online' },
];

export function AutomationsForm({ action, enabled, disabled }: { action: BoundAction; enabled: Record<string, boolean>; disabled: boolean }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          {AUTOMATIONS.map((a) => (
            <div className="settingsrow" key={a.key}>
              <label className="check" style={{ flex: 1 }}>
                <input type="checkbox" name={a.key} defaultChecked={enabled[a.key] !== false} />
                <span>
                  <b>{a.label}</b>
                  <div className="muted">{a.detail}</div>
                </span>
              </label>
            </div>
          ))}
          <FormMessage state={s} />
          {!disabled ? (
            <div className="actions" style={{ marginTop: 10 }}>
              <Submit>Save automations</Submit>
            </div>
          ) : null}
        </fieldset>
      )}
    </ActionForm>
  );
}

export function ThresholdsForm({ action, values, disabled }: { action: BoundAction; values: Record<string, number>; disabled: boolean }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="fields three">
            <Field state={s} name="readyUncollectedDays" label="Ready but uncollected after (days)" type="number" min="1" defaultValue={values.readyUncollectedDays} hint="Also when collection reminders are sent, for orders and workshop jobs" />
            <Field state={s} name="quoteFollowupDays" label="Quote awaiting response after (days)" type="number" min="1" defaultValue={values.quoteFollowupDays} />
            <Field state={s} name="missingSupplierRefDays" label="Not placed / no supplier reference after (days)" type="number" min="0" defaultValue={values.missingSupplierRefDays} />
          </div>
          <FormMessage state={s} />
          {!disabled ? (
            <div className="actions" style={{ marginTop: 10 }}>
              <Submit>Save rules</Submit>
            </div>
          ) : null}
        </fieldset>
      )}
    </ActionForm>
  );
}

export function NewUserForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields">
            <Field state={s} name="name" label="Name" required />
            <Field state={s} name="email" label="Email" type="email" required autoComplete="off" />
            <Field
              state={s}
              name="role"
              label="Role"
              options={[
                { value: 'staff', label: 'Staff — orders, quotes, payments, notes' },
                { value: 'manager', label: 'Manager — plus archive, refunds, suppress emails' },
                { value: 'admin', label: 'Owner / Admin — plus settings, team, backups' },
              ]}
            />
            <label className="check wide">
              <input type="checkbox" name="canSignIn" /> Give them their own email &amp; password (leave unticked if they just pick their name on the shared shop login)
            </label>
            <Field state={s} name="password" label="Temporary password (only if they have their own login)" type="password" autoComplete="new-password" hint="At least 10 characters" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Add team member</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function TeamMemberControls({
  role,
  active,
  isSelf,
  update,
  resetPassword,
}: {
  role: string;
  active: boolean;
  isSelf: boolean;
  update: (patch: { role?: 'admin' | 'manager' | 'staff'; active?: boolean }) => Promise<FormState>;
  /** Present only for accounts that sign in with a password. */
  resetPassword?: () => Promise<FormState>;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        aria-label="Role"
        defaultValue={role}
        disabled={pending || isSelf}
        onChange={(e) => start(async () => setState(await update({ role: e.target.value as 'staff' })))}
        style={{ width: 'auto', padding: '7px 10px' }}
      >
        <option value="staff">Staff</option>
        <option value="manager">Manager</option>
        <option value="admin">Owner / Admin</option>
      </select>
      {!isSelf ? (
        <button type="button" className="btn small" disabled={pending} onClick={() => start(async () => setState(await update({ active: !active })))}>
          {active ? 'Deactivate' : 'Reactivate'}
        </button>
      ) : (
        <span className="muted">You</span>
      )}
      {resetPassword && !isSelf ? (
        <button
          type="button"
          className="btn small"
          disabled={pending}
          onClick={() => {
            if (window.confirm('Give this account a new temporary password? Their current password will stop working.')) {
              start(async () => setState(await resetPassword()));
            }
          }}
        >
          Reset password
        </button>
      ) : null}
      {state?.error ? <span className="err" style={{ color: 'var(--err-ink)', fontSize: 12 }}>{state.error}</span> : null}
      {state?.ok && state.message ? (
        <span className="notice" style={{ display: 'block', margin: '6px 0 0', fontSize: 12 }}>
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

export function PasswordForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields three">
            <Field state={s} name="current" label="Current password" type="password" required autoComplete="current-password" />
            <Field state={s} name="next" label="New password" type="password" required autoComplete="new-password" hint="At least 10 characters" />
            <Field state={s} name="confirm" label="Confirm new password" type="password" required autoComplete="new-password" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Change password</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PaymentTrackingForm({ action, enabled, disabled }: { action: BoundAction; enabled: boolean; disabled: boolean }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="check">
            <input type="checkbox" name="paymentTracking" defaultChecked={enabled} />
            <span>
              <b>Record payments in COS</b>
              <div className="muted">
                Shows the Payments section on each order and checks the balance is paid before an order is marked Collected. Leave off if you take
                payment on your till. Deposits and account credit can still be entered when taking an order.
              </div>
            </span>
          </label>
          <FormMessage state={s} />
          {!disabled ? (
            <div className="actions" style={{ marginTop: 10 }}>
              <Submit>Save</Submit>
            </div>
          ) : null}
        </fieldset>
      )}
    </ActionForm>
  );
}

/** Monthly performance email: on/off and who receives it. */
export function PerformanceReportForm({
  action, enabled, recipients, defaultRecipients, disabled,
}: { action: BoundAction; enabled: boolean; recipients: string[]; defaultRecipients: string[]; disabled?: boolean }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <label className="check">
            <input type="checkbox" name="enabled" defaultChecked={enabled} disabled={disabled} /> Email last month’s performance on the 1st of each month
          </label>
          <div className="fields" style={{ marginTop: 12 }}>
            <Field
              state={s}
              name="recipients"
              label="Send to"
              wide
              textarea
              defaultValue={recipients.join(', ')}
              placeholder={defaultRecipients.length ? `Leave empty to send to the owner: ${defaultRecipients.join(', ')}` : 'name@example.com, another@example.com'}
              hint="Separate addresses with commas. Leave empty to send to the owner/admins."
            />
          </div>
          <FormMessage state={s} />
          {disabled ? null : (
            <div className="actions" style={{ marginTop: 10 }}>
              <Submit className="btn">Save</Submit>
            </div>
          )}
        </>
      )}
    </ActionForm>
  );
}
