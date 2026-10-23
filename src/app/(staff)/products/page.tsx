import type { Metadata } from 'next';
import { InlinePriceForm } from '@/components/ball-range-forms';
import { ActionButton } from '@/components/forms';
import { CatalogueForm } from '@/components/catalogue-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, penceToInput, stamp } from '@/lib/format';
import { CLUB_CATEGORIES } from '@/lib/fitting-rules';
import { getCatalog, listRemovedCatalog } from '@/lib/services/fitting';
import { catalogueAction, catalogueActiveAction, catalogueRemoveAction, componentUpchargeAction, modelPriceAction } from '../actions';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage() {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const [c, removed] = await Promise.all([getCatalog(staff.organisationId, { includeInactive: true }), listRemovedCatalog(staff.organisationId)]);
  const brandName = (id: string) => c.brands.find((b) => b.id === id)?.name ?? '';
  const nameOf = (kind: 'brand' | 'model' | 'component', id: string) =>
    kind === 'brand'
      ? brandName(id)
      : kind === 'model'
        ? (c.models.find((m) => m.id === id)?.name ?? 'this head')
        : (c.components.find((x) => x.id === id)?.name ?? 'this option');
  const retire = (kind: 'brand' | 'model' | 'component', id: string, active: boolean) =>
    manager ? (
      <span className="rowbtns">
        <ActionButton action={catalogueActiveAction.bind(null, kind, id, !active)} className="btn small">
          {active ? 'Retire' : 'Restore'}
        </ActionButton>
        <ActionButton
          action={catalogueRemoveAction.bind(null, kind, id, true)}
          className="btn small danger"
          confirm={
            kind === 'brand'
              ? `Delete ${nameOf(kind, id)} and all its heads and brand options from the catalogue? Quotes and orders keep their details, and you can restore it from Deleted items.`
              : `Delete ${nameOf(kind, id)} from the catalogue? Quotes and orders keep their details, and you can restore it from Deleted items.`
          }
        >
          Delete
        </ActionButton>
      </span>
    ) : null;

  return (
    <>
      <PageHeader staff={staff} title="Products." sub="The fitting catalogue: brands, heads and components with upcharges." actions={<span />} />
      <div className="split">
        <section className="panel">
          <h2>Heads / models</h2>
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Type</th>
                  <th className="num">RRP</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {c.models.map((m) => (
                  <tr key={m.id} style={m.active ? undefined : { opacity: 0.5 }}>
                    <td>
                      <b>
                        {brandName(m.brandId)} {m.name}
                      </b>
                      <div className="muted">
                        {m.sku || 'No SKU'}
                        {m.leadTimeDays ? ` · ${m.leadTimeDays} day lead time` : ''}
                        {m.clubsInSet ? ` · ${m.clubsInSet}-club set` : ''}
                      </div>
                    </td>
                    <td>{CLUB_CATEGORIES.find((k) => k.key === m.category)?.label ?? m.category}</td>
                    <td className="num">
                      {manager ? (
                        <InlinePriceForm action={modelPriceAction.bind(null, m.id)} value={penceToInput(m.basePricePence)} name="basePricePence" label={`RRP for ${m.name}`} />
                      ) : (
                        money(m.basePricePence)
                      )}
                    </td>
                    <td className="num">{retire('model', m.id, m.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {manager ? (
            <details className="section">
              <summary>Add a head / model</summary>
              <CatalogueForm
                action={catalogueAction.bind(null, 'model')}
                kind="model"
                brands={c.brands.filter((b) => b.active).map((b) => ({ value: b.id, label: b.name }))}
                clubTypes={CLUB_CATEGORIES.map((k) => ({ value: k.key, label: k.label }))}
              />
            </details>
          ) : null}
        </section>
        <div>
          <section className="panel">
            <h2>Brands</h2>
            <ul className="attention">
              {c.brands.map((b) => (
                <li key={b.id} style={b.active ? undefined : { opacity: 0.5 }}>
                  <span>
                    <b>{b.name}</b>
                    <div className="muted">{b.tagline}</div>
                  </span>
                  {retire('brand', b.id, b.active)}
                </li>
              ))}
            </ul>
            {manager ? (
              <details className="section">
                <summary>Add a brand</summary>
                <CatalogueForm action={catalogueAction.bind(null, 'brand')} kind="brand" />
              </details>
            ) : null}
          </section>
          <section className="panel">
            <h2>Components</h2>
            {c.categories.map((cat) => {
              const inCat = c.components.filter((x) => x.categoryId === cat.id);
              const groups = [...new Set(inCat.map((x) => x.brandId ?? ''))].sort((a, b) => brandName(a).localeCompare(brandName(b)));
              return (
                <details key={cat.id} className="section">
                  <summary>
                    {cat.label} <span className="muted">({inCat.length})</span>
                  </summary>
                  {groups.map((g) => (
                    <div key={g || 'all'}>
                      <h3>{g ? brandName(g) : 'All brands'}</h3>
                      <ul className="attention">
                        {inCat
                          .filter((x) => (x.brandId ?? '') === g)
                          .map((x) => {
                            const meta = (x.metadata ?? {}) as { clubCategories?: string[]; modelIds?: string[]; perClub?: boolean };
                            const fits = meta.modelIds?.length
                              ? c.models.filter((m) => meta.modelIds!.includes(m.id)).map((m) => m.name).join(', ')
                              : meta.clubCategories?.length
                                ? meta.clubCategories.map((k) => CLUB_CATEGORIES.find((cc) => cc.key === k)?.label ?? k).join(', ')
                                : 'All clubs';
                            return (
                              <li key={x.id} style={x.active ? undefined : { opacity: 0.5 }}>
                                <span>
                                  {x.name}
                                  <div className="muted">
                                    {cat.key === 'set' ? 'Priced per head from its per-club price' : x.upchargePence > 0 ? `+${money(x.upchargePence)}${meta.perClub ? ' per club' : ''}` : 'No upcharge'} · {fits}
                                  </div>
                                </span>
                                <span className="inlineactions">
                                  {manager && cat.key !== 'set' ? (
                                    <InlinePriceForm
                                      action={componentUpchargeAction.bind(null, x.id)}
                                      value={penceToInput(x.upchargePence)}
                                      name="upchargePence"
                                      label={`Upcharge for ${x.name}`}
                                      perClub={cat.key === 'shaft' || cat.key === 'grip' ? Boolean(meta.perClub) : undefined}
                                    />
                                  ) : null}
                                  {retire('component', x.id, x.active)}
                                </span>
                              </li>
                            );
                          })}
                      </ul>
                    </div>
                  ))}
                </details>
              );
            })}
            {manager ? (
              <details className="section">
                <summary>Add a component</summary>
                <CatalogueForm action={catalogueAction.bind(null, 'component')} kind="component" categories={c.categories.map((k) => ({ value: k.id, label: k.label }))} />
              </details>
            ) : null}
          </section>
          {removed.length ? (
            <section className="panel">
              <details className="section">
                <summary>Deleted items ({removed.length})</summary>
                <ul className="attention">
                  {removed.map((r) => (
                    <li key={`${r.kind}-${r.id}`}>
                      <span>
                        <b>{r.name}</b>
                        <div className="muted">
                          {r.detail} · deleted {stamp(r.at, staff.org.timezone)}
                        </div>
                      </span>
                      {manager ? (
                        <ActionButton action={catalogueRemoveAction.bind(null, r.kind, r.id, false)} className="btn small">
                          Restore
                        </ActionButton>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
