import type { ProductModel } from '@/db/schema';

/** Pure fitting rules — shared by the server (validation) and the builder UI. */

export const CLUB_CATEGORIES = [
  { key: 'driver', label: 'Drivers' },
  { key: 'fairway', label: 'Fairways' },
  { key: 'hybrid', label: 'Hybrids' },
  { key: 'irons', label: 'Irons' },
  { key: 'wedge', label: 'Wedges' },
  { key: 'putter', label: 'Putters' },
] as const;

type ComponentLike = { id: string; categoryId: string; metadata: unknown };
type RuleLike = { modelId: string; componentId: string; rule: 'allowed' | 'excluded' | 'default' };

/**
 * Which components are valid for a model:
 * - a component may limit itself to club types via `metadata.clubCategories` (e.g. wood vs iron shafts);
 * - if the model has `allowed`/`default` rules in a category, only those are offered;
 * - `excluded` rules always remove.
 */
export function validComponentIds(
  catalog: { components: ComponentLike[]; rules: RuleLike[] },
  model: Pick<ProductModel, 'id' | 'category'>,
  categoryId: string,
): Set<string> {
  const inCat = catalog.components.filter((c) => {
    const clubs = (c.metadata as { clubCategories?: string[] } | null)?.clubCategories;
    return c.categoryId === categoryId && (!clubs?.length || clubs.includes(model.category));
  });
  const rules = catalog.rules.filter((r) => r.modelId === model.id && inCat.some((c) => c.id === r.componentId));
  const allow = rules.filter((r) => r.rule !== 'excluded').map((r) => r.componentId);
  const deny = new Set(rules.filter((r) => r.rule === 'excluded').map((r) => r.componentId));
  return new Set(inCat.map((c) => c.id).filter((id) => (allow.length ? allow.includes(id) : true) && !deny.has(id)));
}
