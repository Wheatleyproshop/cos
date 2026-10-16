import type { ProductModel } from '@/db/schema';
import type { SpecBuild, SpecLine } from './fit-spec';
import { money } from './format';

/** Pure fitting rules — shared by the server (validation) and the builder UI. */

export const CLUB_CATEGORIES = [
  { key: 'driver', label: 'Drivers' },
  { key: 'fairway', label: 'Fairways' },
  { key: 'hybrid', label: 'Hybrids' },
  { key: 'irons', label: 'Irons' },
  { key: 'wedge', label: 'Wedges' },
  { key: 'putter', label: 'Putters' },
] as const;

type ComponentLike = { id: string; categoryId: string; brandId?: string | null; metadata: unknown };
type ComponentMeta = { clubCategories?: string[]; modelIds?: string[] } | null;
type RuleLike = { modelId: string; componentId: string; rule: 'allowed' | 'excluded' | 'default' };

/**
 * Which components are valid for a model:
 * - a component with a `brandId` is only offered on that brand's heads (e.g. Titleist's stock shafts);
 * - a component may limit itself to club types via `metadata.clubCategories` (e.g. wood vs iron shafts)
 *   or to specific heads via `metadata.modelIds` (e.g. the lofts a driver head comes in);
 * - if the model has `allowed`/`default` rules in a category, only those are offered;
 * - `excluded` rules always remove.
 */
export function validComponentIds(
  catalog: { components: ComponentLike[]; rules: RuleLike[] },
  model: Pick<ProductModel, 'id' | 'category' | 'brandId'>,
  categoryId: string,
): Set<string> {
  const inCat = catalog.components.filter((c) => {
    const meta = c.metadata as ComponentMeta;
    return (
      c.categoryId === categoryId &&
      (!c.brandId || c.brandId === model.brandId) &&
      (!meta?.clubCategories?.length || meta.clubCategories.includes(model.category)) &&
      (!meta?.modelIds?.length || meta.modelIds.includes(model.id))
    );
  });
  const rules = catalog.rules.filter((r) => r.modelId === model.id && inCat.some((c) => c.id === r.componentId));
  const allow = rules.filter((r) => r.rule !== 'excluded').map((r) => r.componentId);
  const deny = new Set(rules.filter((r) => r.rule === 'excluded').map((r) => r.componentId));
  return new Set(inCat.map((c) => c.id).filter((id) => (allow.length ? allow.includes(id) : true) && !deny.has(id)));
}

type PricedComponent = ComponentLike & { upchargePence: number };
type PricedRule = RuleLike & { upchargeOverridePence: number | null };
type PricedModel = Pick<ProductModel, 'id' | 'category' | 'clubsInSet'>;

export function isPerClub(c: { metadata: unknown }) {
  return Boolean((c.metadata as { perClub?: boolean } | null)?.perClub);
}

/**
 * How many clubs a build contains: an iron set's chosen make-up (or the head's standard set),
 * otherwise one club.
 */
export function clubsInBuild(model: PricedModel, chosen: { metadata: unknown }[]) {
  if (model.category !== 'irons' || !model.clubsInSet) return 1;
  const set = chosen.map((c) => (c.metadata as { clubs?: number } | null)?.clubs).find((n) => typeof n === 'number');
  return set ?? model.clubsInSet;
}

/**
 * A component's price on this build: a head-specific override, or its upcharge — multiplied by
 * the number of clubs when it is charged per club (e.g. a premium iron shaft on a 7-club set).
 */
export function componentPrice(
  catalog: { rules: PricedRule[] },
  model: PricedModel,
  component: PricedComponent,
  chosen: { metadata: unknown }[],
) {
  const override = catalog.rules.find((r) => r.modelId === model.id && r.componentId === component.id)?.upchargeOverridePence;
  const each = override ?? component.upchargePence;
  return isPerClub(component) ? each * clubsInBuild(model, chosen) : each;
}

type BuildCatalog = {
  brands: { id: string; name: string }[];
  categories: { id: string; label: string }[];
  components: (PricedComponent & { name: string })[];
  rules: PricedRule[];
};
type BuildModel = PricedModel & { name: string; brandId: string; basePricePence: number };

/**
 * Prices one club build into display lines (Head, then each chosen option in step order).
 * The builder and quote creation both use this, so what staff see is what the customer is quoted.
 */
export function priceBuild(catalog: BuildCatalog, model: BuildModel, componentIds: string[], notes = ''): SpecBuild {
  const chosen = componentIds.map((id) => catalog.components.find((c) => c.id === id)).filter((c): c is BuildCatalog['components'][number] => Boolean(c));
  const clubs = clubsInBuild(model, chosen);
  const brand = catalog.brands.find((b) => b.id === model.brandId)?.name ?? '';
  const title = `${brand} ${model.name}`.trim();
  const lines: SpecLine[] = [
    { label: 'Head', value: title, pricePence: model.basePricePence, detail: model.category === 'irons' && model.clubsInSet ? `standard ${model.clubsInSet}-club set` : undefined },
  ];
  for (const cat of catalog.categories) {
    for (const c of chosen.filter((x) => x.categoryId === cat.id)) {
      const price = componentPrice(catalog, model, c, chosen);
      const perClub = isPerClub(c) && clubs > 1 && price !== 0;
      lines.push({ label: cat.label, value: c.name, pricePence: price, detail: perClub ? `${money(price / clubs)} × ${clubs} clubs` : undefined });
    }
  }
  return { title, brand: brand || undefined, category: model.category, lines, notes: notes || undefined, totalPence: lines.reduce((s, l) => s + l.pricePence, 0) };
}
