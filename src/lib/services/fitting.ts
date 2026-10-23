import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db';
import {
  brands,
  componentCategories,
  components,
  configurationQuoteItems,
  configurationQuotes,
  modelComponentRules,
  productModels,
} from '@/db/schema';
import { recordEvent } from '../audit';
import { money, parseMoneyToPence } from '../format';
import { hasFeature } from '../plans';
import { customerFields, parse } from '../validation';
import { fitSpecText, type FitSpec } from '../fit-spec';
import { CLUB_CATEGORIES, isPerClub, priceBuild, validComponentIds } from '../fitting-rules';
import { requireRole, ServiceError, type Ctx } from './common';
import { createQuote } from './quotes';

export type Catalog = Awaited<ReturnType<typeof getCatalog>>;
export { CLUB_CATEGORIES, validComponentIds };

/** Everything the Custom Fitting builder needs, in one tenant-scoped read. */
export async function getCatalog(orgId: string, opts: { includeInactive?: boolean } = {}) {
  return withTenant(orgId, async (tx) => {
    // Deleted items never show; retired ones only when asked for (the catalogue page).
    const shown = <T extends { active: unknown; removedAt: unknown }>(t: T) =>
      and(isNull(t.removedAt as never), opts.includeInactive ? undefined : eq(t.active as never, true));
    const [b, m, cats, comps, rules] = await Promise.all([
      tx.select().from(brands).where(shown(brands)).orderBy(asc(brands.sortOrder), asc(brands.name)),
      tx.select().from(productModels).where(shown(productModels)).orderBy(asc(productModels.name)),
      tx.select().from(componentCategories).orderBy(asc(componentCategories.sortOrder)),
      tx.select().from(components).where(shown(components)).orderBy(asc(components.upchargePence), asc(components.name)),
      tx.select().from(modelComponentRules),
    ]);
    return { brands: b, models: m, categories: cats, components: comps, rules };
  });
}

const buildSchema = z.object({
  modelId: z.string().uuid('Choose a head'),
  componentIds: z.array(z.string().uuid()).max(20).default([]),
  notes: z.string().trim().max(1000).default(''),
});

const fittingSchema = z.object({
  ...customerFields,
  builds: z.array(buildSchema).min(1, 'Add at least one club to the quote').max(20, 'A quote can hold up to 20 clubs'),
  buildNotes: z.string().trim().max(2000).default(''),
  validUntil: z.string().trim().default(''),
});

/**
 * Turns a fitting — one club or a whole bag — into a normal quote (so approval, conversion and
 * audit are shared). Each club is priced on the server with the same rules as the builder, kept
 * as structured lines in `specification_json`, and recorded as configuration items.
 */
export async function createFittingQuote(ctx: Ctx, raw: unknown, opts: { send: boolean }) {
  if (!hasFeature(ctx.org, 'configure')) throw new ServiceError('Custom Fitting is part of the Pro plan.');
  // A single club may also be posted the original way (modelId + componentIds).
  const r = (raw ?? {}) as Record<string, unknown>;
  const input = parse(fittingSchema, r.builds === undefined && r.modelId ? { ...r, builds: [{ modelId: r.modelId, componentIds: r.componentIds ?? [] }] } : r);
  const catalog = await getCatalog(ctx.org.id);

  const clubs = input.builds.map((b) => {
    const model = catalog.models.find((m) => m.id === b.modelId);
    if (!model) throw new ServiceError('One of the heads is no longer available.', { builds: 'Check the clubs in this quote' });
    const chosen = b.componentIds.map((id) => {
      const c = catalog.components.find((x) => x.id === id);
      if (!c) throw new ServiceError('One of the selected options is no longer available.');
      const cat = catalog.categories.find((k) => k.id === c.categoryId)!;
      if (!validComponentIds(catalog, model, cat.id).has(c.id)) throw new ServiceError(`${c.name} isn’t available with the ${model.name}.`);
      return { component: c, category: cat };
    });
    for (const cat of catalog.categories) {
      if (!cat.allowMultiple && chosen.filter((c) => c.category.id === cat.id).length > 1) {
        throw new ServiceError(`Choose one ${cat.label.toLowerCase()} for the ${model.name}.`);
      }
    }
    const build = priceBuild(catalog, model, b.componentIds, b.notes);
    return { model, chosen, build };
  });

  const total = clubs.reduce((s, c) => s + c.build.totalPence, 0);
  const leadDays = Math.max(0, ...clubs.flatMap((c) => [c.model.leadTimeDays ?? 0, ...c.chosen.map((x) => x.component.leadTimeDays ?? 0)]));
  const spec: FitSpec = { kind: 'cos-configure', version: 2, builds: clubs.map((c) => c.build), notes: input.buildNotes || undefined, totalPence: total };
  const brandNames = [...new Set(clubs.map((c) => catalog.brands.find((b) => b.id === c.model.brandId)?.name ?? ''))];
  const single = clubs.length === 1 ? clubs[0] : null;

  return createQuote(
    ctx,
    {
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
      customerId: input.customerId ?? '',
      brand: brandNames.join(' / '),
      product: single ? single.model.name : `Custom fitting — ${clubs.length} clubs`,
      sku: single ? single.model.sku : '',
      specificationText: fitSpecText(spec),
      totalGrossPence: (total / 100).toFixed(2),
      depositRequiredPence: '0',
      estimatedLeadTime: leadDays ? `About ${Math.ceil(leadDays / 7)} week${leadDays > 7 ? 's' : ''}` : '',
      validUntil: input.validUntil,
      internalNotes: 'Built with Custom Fitting.',
    },
    {
      send: opts.send,
      specificationJson: spec,
      afterInsert: async (tx, quote) => {
        for (const c of clubs) {
          const [cq] = await tx
            .insert(configurationQuotes)
            .values({
              organisationId: ctx.org.id, quoteId: quote.id, modelId: c.model.id, summaryText: fitSpecText({ ...spec, builds: [c.build], notes: undefined }),
              totalPence: c.build.totalPence, leadTimeDays: c.model.leadTimeDays ?? null,
            })
            .returning();
          if (c.chosen.length) {
            await tx.insert(configurationQuoteItems).values(
              c.chosen.map((x) => ({
                organisationId: ctx.org.id, configurationQuoteId: cq.id, categoryId: x.category.id, componentId: x.component.id,
                label: x.category.label, value: x.component.name,
                upchargePence: c.build.lines.find((l) => l.label === x.category.label && l.value === x.component.name)?.pricePence ?? 0,
              })),
            );
          }
        }
      },
    },
  );
}

/* ───────────────────────────── Catalogue admin ───────────────────────────── */

const pence = (label: string) =>
  z.string().transform((v, c) => {
    const p = parseMoneyToPence(v || '0');
    if (p === null || p < 0) {
      c.addIssue({ code: 'custom', message: `${label} must be an amount like 529.00` });
      return z.NEVER;
    }
    return p;
  });

const brandSchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(60), tagline: z.string().trim().max(120).default('') });
const modelSchema = z.object({
  brandId: z.string().uuid('Choose a brand'),
  category: z.enum(CLUB_CATEGORIES.map((c) => c.key) as [string, ...string[]]),
  name: z.string().trim().min(1, 'Name is required').max(120),
  sku: z.string().trim().max(80).default(''),
  basePricePence: pence('Price'),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(0),
  season: z.string().trim().max(20).default(''),
  clubsInSet: z.coerce.number().int().min(0).max(14).default(0),
});
const componentSchema = z.object({
  categoryId: z.string().uuid('Choose a step'),
  name: z.string().trim().min(1, 'Name is required').max(120),
  upchargePence: pence('Upcharge'),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(0),
});

async function audit(ctx: Ctx, what: string, value: Record<string, unknown>) {
  await withTenant(ctx.org.id, (tx) =>
    recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id, newValue: value, metadata: { section: `catalogue.${what}` } }),
  );
}

export async function addBrand(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(brandSchema, raw);
  await withTenant(ctx.org.id, (tx) => tx.insert(brands).values({ organisationId: ctx.org.id, ...v }));
  await audit(ctx, 'brand_added', v);
}

export async function addModel(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(modelSchema, raw);
  const clubsInSet = v.category === 'irons' && v.clubsInSet > 1 ? v.clubsInSet : null;
  await withTenant(ctx.org.id, (tx) => tx.insert(productModels).values({ organisationId: ctx.org.id, ...v, clubsInSet, leadTimeDays: v.leadTimeDays || null }));
  await audit(ctx, 'model_added', v);
}

export async function addComponent(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(componentSchema, raw);
  await withTenant(ctx.org.id, (tx) => tx.insert(components).values({ organisationId: ctx.org.id, ...v, value: v.name, leadTimeDays: v.leadTimeDays || null }));
  await audit(ctx, 'component_added', v);
}

/** Changes a head's RRP. The old and new price go in the audit trail; existing quotes keep their price. */
export async function updateModelPrice(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(z.object({ basePricePence: pence('Price') }), raw);
  if (v.basePricePence <= 0) throw new ServiceError('Enter a price above £0.', { basePricePence: 'Required' });
  const [before] = await withTenant(ctx.org.id, async (tx) => {
    const rows = await tx.select().from(productModels).where(and(eq(productModels.id, id), eq(productModels.organisationId, ctx.org.id)));
    if (rows[0]) await tx.update(productModels).set(v).where(eq(productModels.id, id));
    return rows;
  });
  if (!before) throw new ServiceError('That head is no longer in the catalogue.');
  if (before.basePricePence === v.basePricePence) return;
  await withTenant(ctx.org.id, (tx) =>
    recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { model: before.name, basePricePence: before.basePricePence }, newValue: { model: before.name, ...v },
      metadata: { section: 'catalogue.model_price' },
    }),
  );
}

/**
 * Changes a shaft/grip/other option's upcharge. Iron set make-ups are priced per head
 * (from the per-club price), so they aren't edited here.
 */
export async function updateComponentUpcharge(ctx: Ctx, id: string, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(z.object({ upchargePence: pence('Upcharge'), perClub: z.string().optional().transform((x) => x === 'on' || x === 'true') }), raw);
  const before = await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .select({ c: components, key: componentCategories.key })
      .from(components)
      .innerJoin(componentCategories, eq(componentCategories.id, components.categoryId))
      .where(and(eq(components.id, id), eq(components.organisationId, ctx.org.id)));
    if (!row) throw new ServiceError('That option is no longer in the catalogue.');
    if (row.key === 'set') throw new ServiceError('Set make-ups are priced from each head’s per-club price.');
    const wasPerClub = isPerClub(row.c);
    if (row.c.upchargePence !== v.upchargePence || wasPerClub !== v.perClub) {
      const metadata = { ...((row.c.metadata ?? {}) as Record<string, unknown>), perClub: v.perClub };
      await tx.update(components).set({ upchargePence: v.upchargePence, metadata }).where(eq(components.id, id));
    }
    return { ...row.c, perClub: wasPerClub };
  });
  if (before.upchargePence === v.upchargePence && before.perClub === v.perClub) return;
  await withTenant(ctx.org.id, (tx) =>
    recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'settings_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { component: before.name, upchargePence: before.upchargePence, perClub: before.perClub }, newValue: { component: before.name, ...v },
      metadata: { section: 'catalogue.component_upcharge' },
    }),
  );
}

/** Catalogue items are retired, never deleted, so old quotes keep their references. */
/** Deleted catalogue items, newest first, for the "Deleted" list on the catalogue page. */
export async function listRemovedCatalog(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const [b, m, comps] = await Promise.all([
      tx.select().from(brands).where(isNotNull(brands.removedAt)),
      tx.select({ model: productModels, brand: brands.name }).from(productModels).innerJoin(brands, eq(brands.id, productModels.brandId)).where(isNotNull(productModels.removedAt)),
      tx.select({ c: components, category: componentCategories.label }).from(components).innerJoin(componentCategories, eq(componentCategories.id, components.categoryId)).where(isNotNull(components.removedAt)),
    ]);
    // A brand's heads/options deleted along with it are restored with it, so they aren't listed separately.
    const withBrand = new Map(b.map((x) => [x.id, x.removedAt!.getTime()]));
    const cascaded = (brandId: string | null, at: Date) => brandId !== null && withBrand.get(brandId) === at.getTime();
    return [
      ...b.map((x) => ({ kind: 'brand' as const, id: x.id, name: x.name, detail: 'Brand, with its heads and brand options', at: x.removedAt! })),
      ...m.filter((x) => !cascaded(x.model.brandId, x.model.removedAt!)).map((x) => ({ kind: 'model' as const, id: x.model.id, name: `${x.brand} ${x.model.name}`, detail: 'Head', at: x.model.removedAt! })),
      ...comps.filter((x) => !cascaded(x.c.brandId, x.c.removedAt!)).map((x) => ({ kind: 'component' as const, id: x.c.id, name: x.c.name, detail: x.category, at: x.c.removedAt! })),
    ].sort((a, z) => z.at.getTime() - a.at.getTime());
  });
}

/**
 * Deletes a brand, head or option from the catalogue (or restores it). Nothing is erased: quotes
 * and orders keep their own copy, the row is hidden everywhere, and it can be restored from the
 * Deleted list. Deleting a brand takes its heads and brand-specific options with it.
 */
export async function setCatalogRemoved(ctx: Ctx, kind: 'brand' | 'model' | 'component', id: string, removed: boolean) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const name = await withTenant(ctx.org.id, async (tx) => {
    const table = kind === 'brand' ? brands : kind === 'model' ? productModels : components;
    const [row] = await tx.select().from(table).where(and(eq(table.id, id), eq(table.organisationId, ctx.org.id))).limit(1);
    if (!row) throw new ServiceError('That item is no longer in the catalogue.');
    if (removed) {
      const now = new Date();
      await tx.update(table).set({ removedAt: now, active: false }).where(eq(table.id, id));
      if (kind === 'brand') {
        await tx.update(productModels).set({ removedAt: now, active: false }).where(and(eq(productModels.brandId, id), isNull(productModels.removedAt)));
        await tx.update(components).set({ removedAt: now, active: false }).where(and(eq(components.brandId, id), isNull(components.removedAt)));
      }
    } else {
      if (!row.removedAt) return row.name;
      await tx.update(table).set({ removedAt: null, active: true }).where(eq(table.id, id));
      if (kind === 'brand') {
        await tx.update(productModels).set({ removedAt: null, active: true }).where(and(eq(productModels.brandId, id), eq(productModels.removedAt, row.removedAt)));
        await tx.update(components).set({ removedAt: null, active: true }).where(and(eq(components.brandId, id), eq(components.removedAt, row.removedAt)));
      } else if (kind === 'model' || (kind === 'component' && 'brandId' in row && row.brandId)) {
        // Restoring a head or option of a deleted brand brings the brand back too.
        const brandId = (row as { brandId: string | null }).brandId!;
        await tx.update(brands).set({ removedAt: null, active: true }).where(and(eq(brands.id, brandId), isNotNull(brands.removedAt)));
      }
    }
    return row.name;
  });
  await audit(ctx, removed ? `${kind}_deleted` : `${kind}_undeleted`, { id, name });
}

export async function setCatalogActive(ctx: Ctx, kind: 'brand' | 'model' | 'component', id: string, active: boolean) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  await withTenant(ctx.org.id, async (tx) => {
    const table = kind === 'brand' ? brands : kind === 'model' ? productModels : components;
    await tx.update(table).set({ active }).where(and(eq(table.id, id), eq(table.organisationId, ctx.org.id)));
  });
  await audit(ctx, active ? `${kind}_restored` : `${kind}_retired`, { id });
}

