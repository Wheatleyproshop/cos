import type { Metadata } from 'next';
import { ActionButton } from '@/components/forms';
import { CatalogueForm } from '@/components/catalogue-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { CLUB_CATEGORIES } from '@/lib/fitting-rules';
import { getCatalog } from '@/lib/services/fitting';
import { catalogueAction, catalogueActiveAction } from '../actions';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage() {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const c = await getCatalog(staff.organisationId, { includeInactive: true });
  const brandName = (id: string) => c.brands.find((b) => b.id === id)?.name ?? '';
  const retire = (kind: 'brand' | 'model' | 'component', id: string, active: boolean) =>
    manager ? (
      <ActionButton action={catalogueActiveAction.bind(null, kind, id, !active)} className="btn small">
        {active ? 'Retire' : 'Restore'}
      </ActionButton>
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
                      </div>
                    </td>
                    <td>{CLUB_CATEGORIES.find((k) => k.key === m.category)?.label ?? m.category}</td>
                    <td className="num">{money(m.basePricePence)}</td>
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
                            const meta = (x.metadata ?? {}) as { clubCategories?: string[]; modelIds?: string[] };
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
                                    {x.upchargePence > 0 ? `+${money(x.upchargePence)}` : x.upchargePence < 0 ? `−${money(-x.upchargePence)}` : 'No upcharge'} · {fits}
                                  </div>
                                </span>
                                {retire('component', x.id, x.active)}
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
        </div>
      </div>
    </>
  );
}
