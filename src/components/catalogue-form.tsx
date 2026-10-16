'use client';

import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

type Opt = { value: string; label: string };

export function CatalogueForm({
  action,
  kind,
  brands = [],
  clubTypes = [],
  categories = [],
}: {
  action: BoundAction;
  kind: 'brand' | 'model' | 'component';
  brands?: Opt[];
  clubTypes?: Opt[];
  categories?: Opt[];
}) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields">
            {kind === 'brand' ? (
              <>
                <Field state={s} name="name" label="Brand name" required />
                <Field state={s} name="tagline" label="Short description" />
              </>
            ) : kind === 'model' ? (
              <>
                <Field state={s} name="brandId" label="Brand" options={brands} />
                <Field state={s} name="category" label="Club type" options={clubTypes} />
                <Field state={s} name="name" label="Model name" required placeholder="e.g. G440 MAX Driver" />
                <Field state={s} name="sku" label="SKU" />
                <Field state={s} name="basePricePence" label="RRP (GBP)" required inputMode="decimal" hint="Irons: the price of the whole set" />
                <Field state={s} name="clubsInSet" label="Irons: clubs in that set" type="number" min="0" defaultValue="6" hint="Used to price per-club shaft and grip upcharges" />
                <Field state={s} name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue="10" />
              </>
            ) : (
              <>
                <Field state={s} name="categoryId" label="Step" options={categories} />
                <Field state={s} name="name" label="Name" required placeholder="e.g. Fujikura Ventus Blue 6S" />
                <Field state={s} name="upchargePence" label="Upcharge (GBP)" inputMode="decimal" defaultValue="0.00" />
                <Field state={s} name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue="0" />
              </>
            )}
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit className="btn">Add</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
