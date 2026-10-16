import { and, asc, eq } from 'drizzle-orm';
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
import { CLUB_CATEGORIES, validComponentIds } from '../fitting-rules';
import { requireRole, ServiceError, type Ctx } from './common';
import { createQuote } from './quotes';

export type Catalog = Awaited<ReturnType<typeof getCatalog>>;
export { CLUB_CATEGORIES, validComponentIds };

/** Everything the Custom Fitting builder needs, in one tenant-scoped read. */
export async function getCatalog(orgId: string, opts: { includeInactive?: boolean } = {}) {
  return withTenant(orgId, async (tx) => {
    const activeOnly = <T extends { active: unknown }>(t: T) => (opts.includeInactive ? undefined : eq(t.active as never, true));
    const [b, m, cats, comps, rules] = await Promise.all([
      tx.select().from(brands).where(activeOnly(brands)).orderBy(asc(brands.sortOrder), asc(brands.name)),
      tx.select().from(productModels).where(activeOnly(productModels)).orderBy(asc(productModels.name)),
      tx.select().from(componentCategories).orderBy(asc(componentCategories.sortOrder)),
      tx.select().from(components).where(activeOnly(components)).orderBy(asc(components.upchargePence), asc(components.name)),
      tx.select().from(modelComponentRules),
    ]);
    return { brands: b, models: m, categories: cats, components: comps, rules };
  });
}

const fittingSchema = z.object({
  ...customerFields,
  modelId: z.string().uuid('Choose a head'),
  componentIds: z.array(z.string().uuid()).max(20).default([]),
  buildNotes: z.string().trim().max(2000).default(''),
  validUntil: z.string().trim().default(''),
});

/**
 * Turns a fitting into a normal quote (so approval, conversion and audit are shared),
 * with a structured build in `specification_json` and priced configuration items.
 */
export async function createFittingQuote(ctx: Ctx, raw: unknown, opts: { send: boolean }) {
  if (!hasFeature(ctx.org, 'configure')) throw new ServiceError('Custom Fitting is part of the Pro plan.');
  const input = parse(fittingSchema, raw);
  const catalog = await getCatalog(ctx.org.id);
  const model = catalog.models.find((m) => m.id === input.modelId);
  if (!model) throw new ServiceError('That head is no longer available.', { modelId: 'Choose another head' });
  const brand = catalog.brands.find((b) => b.id === model.brandId)!;

  const chosen = input.componentIds.map((id) => {
    const c = catalog.components.find((x) => x.id === id);
    if (!c) throw new ServiceError('One of the selected components is no longer available.');
    const cat = catalog.categories.find((k) => k.id === c.categoryId)!;
    if (!validComponentIds(catalog, model, cat.id).has(c.id)) {
      throw new ServiceError(`${c.name} isn’t available with the ${model.name}.`);
    }
    const override = catalog.rules.find((r) => r.modelId === model.id && r.componentId === c.id)?.upchargeOverridePence;
    return { component: c, category: cat, upcharge: override ?? c.upchargePence };
  });
  for (const cat of catalog.categories) {
    if (!cat.allowMultiple && chosen.filter((c) => c.category.id === cat.id).length > 1) {
      throw new ServiceError(`Choose one ${cat.label.toLowerCase()}.`);
    }
  }

  const total = model.basePricePence + chosen.reduce((s, c) => s + c.upcharge, 0);
  const leadDays = Math.max(model.leadTimeDays ?? 0, ...chosen.map((c) => c.component.leadTimeDays ?? 0));
  const lines = [
    `Head: ${brand.name} ${model.name} — ${money(model.basePricePence)}`,
    ...chosen.map((c) => `${c.category.label}: ${c.component.name}${c.upcharge ? ` — ${money(c.upcharge)}` : ''}`),
    ...(input.buildNotes ? ['', input.buildNotes] : []),
  ];
  const spec = {
    kind: 'cos-configure',
    version: 1,
    model: { id: model.id, name: model.name, brand: brand.name, category: model.category, basePricePence: model.basePricePence },
    items: chosen.map((c) => ({ categoryKey: c.category.key, category: c.category.label, componentId: c.component.id, name: c.component.name, upchargePence: c.upcharge })),
    notes: input.buildNotes,
    totalPence: total,
  };

  return createQuote(
    ctx,
    {
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
      brand: brand.name,
      product: model.name,
      sku: model.sku,
      specificationText: lines.join('\n'),
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
        const [cq] = await tx
          .insert(configurationQuotes)
          .values({
            organisationId: ctx.org.id, quoteId: quote.id, modelId: model.id, summaryText: lines.join('\n'),
            totalPence: total, leadTimeDays: leadDays || null,
          })
          .returning();
        if (chosen.length) {
          await tx.insert(configurationQuoteItems).values(
            chosen.map((c) => ({
              organisationId: ctx.org.id, configurationQuoteId: cq.id, categoryId: c.category.id, componentId: c.component.id,
              label: c.category.label, value: c.component.name, upchargePence: c.upcharge,
            })),
          );
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
  await withTenant(ctx.org.id, (tx) => tx.insert(productModels).values({ organisationId: ctx.org.id, ...v, leadTimeDays: v.leadTimeDays || null }));
  await audit(ctx, 'model_added', v);
}

export async function addComponent(ctx: Ctx, raw: unknown) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  const v = parse(componentSchema, raw);
  await withTenant(ctx.org.id, (tx) => tx.insert(components).values({ organisationId: ctx.org.id, ...v, value: v.name, leadTimeDays: v.leadTimeDays || null }));
  await audit(ctx, 'component_added', v);
}

/** Catalogue items are retired, never deleted, so old quotes keep their references. */
export async function setCatalogActive(ctx: Ctx, kind: 'brand' | 'model' | 'component', id: string, active: boolean) {
  requireRole(ctx, 'manager', 'edit the product catalogue');
  await withTenant(ctx.org.id, async (tx) => {
    const table = kind === 'brand' ? brands : kind === 'model' ? productModels : components;
    await tx.update(table).set({ active }).where(and(eq(table.id, id), eq(table.organisationId, ctx.org.id)));
  });
  await audit(ctx, active ? `${kind}_restored` : `${kind}_retired`, { id });
}

