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
