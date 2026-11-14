'use client';

import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';
import { CATEGORY_OPTIONS } from './order-forms';

const HAND_OPTIONS = [
  { value: '', label: 'Not applicable' },
  { value: 'Right-handed', label: 'Right-handed' },
  { value: 'Left-handed', label: 'Left-handed' },
];

/** The customer's special order request (public page). Success replaces the form with the thank-you message. */
export function OrderRequestForm({ action, brands, neededBy }: { action: BoundAction; brands: string[]; neededBy: readonly string[] }) {
  return (
    <ActionForm action={action}>
      {(s) =>
        s?.ok && s.message ? (
          <div className="notice ok request-done" role="status">
            <b>Request sent</b>
            <p>{s.message}</p>
          </div>
        ) : (
          <>
            <h2 className="request-h">What are you looking for?</h2>
            <div className="fields">
              <label className="field">
                <span>Brand *</span>
                <input name="brand" list="request-brands" required defaultValue={s?.values?.brand} aria-invalid={s?.fieldErrors?.brand ? true : undefined} placeholder="e.g. Titleist" />
                <datalist id="request-brands">
                  {brands.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
                {s?.fieldErrors?.brand ? <span className="err">{s.fieldErrors.brand}</span> : null}
              </label>
              <Field state={s} name="category" label="Type of item" options={CATEGORY_OPTIONS} />
              <Field state={s} name="product" label="Product" required placeholder="e.g. GT2 Driver, Pro V1 balls, Tour Alpha shoes" wide />
              <Field state={s} name="colour" label="Colour" />
              <Field state={s} name="size" label="Size" hint="Clothing, shoes or glove size" />
              <Field state={s} name="hand" label="Hand" options={HAND_OPTIONS} />
              <Field state={s} name="quantity" label="Quantity" type="number" min="1" defaultValue="1" />
              <Field
                state={s}
                name="details"
                label="Anything else we should know"
                textarea
                wide
                hint="Loft, shaft and flex, lie angle, grip, a link to the product you’ve seen — the more detail the better."
              />
              <Field state={s} name="neededBy" label="When do you need it?" options={neededBy.map((n) => ({ value: n, label: n }))} />
              <Field state={s} name="budget" label="Budget (optional)" placeholder="e.g. around £400" />
            </div>
            <h2 className="request-h">Your details</h2>
            <div className="fields">
              <Field state={s} name="customerName" label="Your name" required autoComplete="name" />
              <Field state={s} name="email" label="Email" type="email" required autoComplete="email" inputMode="email" />
              <Field state={s} name="phone" label="Mobile (optional)" type="tel" autoComplete="tel" inputMode="tel" hint="So we can text you when it arrives" />
            </div>
            <label className="bp-hp" aria-hidden="true">
              Website <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
            <p className="muted request-small">
              We’ll only use your details to reply about this request and any order that follows. Nothing is ordered or charged until you approve a quote.
            </p>
            <FormMessage state={s} />
            <div className="actions">
              <Submit pendingText="Sending…">Send request</Submit>
            </div>
          </>
        )
      }
    </ActionForm>
  );
}
