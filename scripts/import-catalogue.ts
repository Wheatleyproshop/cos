import './env';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/db';
import {
  auditEvents, brands, componentCategories, components, modelComponentRules, organisations, productModels,
} from '../src/db/schema';

/**
 * Loads a manufacturer catalogue (heads, lofts, iron set make-ups, shafts, flexes, grips) into a
 * shop's Custom Fitting catalogue.
 *   npm run catalogue:import -- --shop desirable-golf --file catalogue.json [--dry-run]
 *
 * The file is an array of brands in the shape produced by our catalogue research
 * (see docs/CONFIGURE.md). Safe to re-run: everything is matched by name and updated in
 * place, nothing is ever deleted, and items the shop has retired stay retired.
 */

type Club = 'driver' | 'fairway' | 'hybrid' | 'irons' | 'wedge' | 'putter';
type InModel = {
  category: Club; name: string; season?: string; rrpGBP: number | null; priceBasis?: 'each' | 'set';
  setMakeup?: string; perClubGBP?: number | null; lofts?: string[]; specNotes?: string;
};
type InPart = { name: string; clubTypes: Club[]; flexes?: string[]; upchargeGBP: number | null; stock?: boolean };
type InBrand = { brand: string; tagline?: string; models: InModel[]; shafts: InPart[]; grips: InPart[] };

const CATEGORIES = [
  { key: 'loft', label: 'Loft', sortOrder: 1 },
  { key: 'set', label: 'Set make-up', sortOrder: 2 },
  { key: 'shaft', label: 'Shaft', sortOrder: 3 },
  { key: 'flex', label: 'Flex', sortOrder: 4 },
  { key: 'grip', label: 'Grip', sortOrder: 5 },
];
const FLEXES = ['Ladies', 'Senior (A)', 'Soft Regular (SR)', 'Regular', 'Stiff', 'Extra Stiff', 'Tour X'];
const SHAFTED: Club[] = ['driver', 'fairway', 'hybrid', 'irons', 'wedge'];
// Common iron set make-ups, by number of clubs.
const SETS = [
  { name: '6-PW (5 clubs)', clubs: 5 },
  { name: '5-PW (6 clubs)', clubs: 6 },
  { name: '4-PW (7 clubs)', clubs: 7 },
  { name: '5-PW + GW (7 clubs)', clubs: 7 },
  { name: '4-PW + GW (8 clubs)', clubs: 8 },
];

const pence = (gbp: number | null | undefined) => (gbp == null ? null : Math.round(gbp * 100));

async function main() {
  const { values: a } = parseArgs({ options: { shop: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!a.shop || !a.file) throw new Error('Usage: --shop <slug> --file <catalogue.json> [--dry-run]');
  const input = JSON.parse(readFileSync(a.file, 'utf8')) as InBrand[];
  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  const report: string[] = [];
  const skipped: string[] = [];
  try {
    await h.db.transaction(async (tx) => {
      const [org] = await tx.select().from(organisations).where(eq(organisations.slug, a.shop!));
      if (!org) throw new Error(`Workspace ${a.shop} not found`);
      const orgId = org.id;
      const counts = { brands: 0, models: 0, lofts: 0, shafts: 0, grips: 0, sets: 0 };

      // Fitting steps
      const cat: Record<string, string> = {};
      for (const c of CATEGORIES) {
        const [found] = await tx.select().from(componentCategories).where(and(eq(componentCategories.organisationId, orgId), eq(componentCategories.key, c.key)));
        cat[c.key] = found
          ? found.id
          : (await tx.insert(componentCategories).values({ organisationId: orgId, ...c }).returning())[0].id;
      }

      const upsertComponent = async (v: {
        categoryKey: string; brandId: string | null; name: string; upchargePence: number; metadata: Record<string, unknown>; mergeModelIds?: boolean;
      }) => {
        const [found] = await tx
          .select()
          .from(components)
          .where(and(
            eq(components.organisationId, orgId), eq(components.categoryId, cat[v.categoryKey]), eq(components.name, v.name),
            v.brandId ? eq(components.brandId, v.brandId) : sql`${components.brandId} is null`,
          ));
        if (found) {
          const prev = (found.metadata ?? {}) as { modelIds?: string[] };
          const metadata = v.mergeModelIds
            ? { ...v.metadata, modelIds: [...new Set([...(prev.modelIds ?? []), ...((v.metadata.modelIds as string[]) ?? [])])] }
            : v.metadata;
          await tx.update(components).set({ upchargePence: v.upchargePence, metadata }).where(eq(components.id, found.id));
          return found.id;
        }
        const [row] = await tx
          .insert(components)
          .values({ organisationId: orgId, categoryId: cat[v.categoryKey], brandId: v.brandId, name: v.name, value: v.name, upchargePence: v.upchargePence, metadata: v.metadata })
          .returning();
        return row.id;
      };

      // Flex applies to every brand's shafted clubs.
      for (const f of FLEXES) await upsertComponent({ categoryKey: 'flex', brandId: null, name: f, upchargePence: 0, metadata: { clubCategories: SHAFTED } });

      for (const b of input) {
        const [existing] = await tx.select().from(brands).where(and(eq(brands.organisationId, orgId), sql`lower(${brands.name}) = ${b.brand.toLowerCase()}`));
        const brandId = existing
          ? (await tx.update(brands).set({ tagline: b.tagline ?? existing.tagline }).where(eq(brands.id, existing.id)).returning())[0].id
          : (await tx.insert(brands).values({ organisationId: orgId, name: b.brand, tagline: b.tagline ?? '' }).returning())[0].id;
        counts.brands++;

        for (const m of b.models) {
          // Irons sold per club are priced as the standard 5-PW set.
          // Single irons (e.g. utility/driving irons) are priced each and have no set make-up.
          const single = m.category === 'irons' && /single/i.test(m.setMakeup ?? '');
          const isIrons = m.category === 'irons' && !single;
          const perClub = pence(m.perClubGBP);
          const base = isIrons && m.priceBasis === 'each' ? (perClub != null ? perClub * 6 : null) : pence(m.rrpGBP);
          if (base == null) {
            skipped.push(`${b.brand} ${m.name} (no UK price found)`);
            continue;
          }
          const [found] = await tx.select().from(productModels).where(and(eq(productModels.organisationId, orgId), eq(productModels.brandId, brandId), eq(productModels.name, m.name)));
          const values = { category: m.category, season: m.season ?? '', basePricePence: base, sku: found?.sku ?? '' };
          const modelId = found
            ? (await tx.update(productModels).set(values).where(eq(productModels.id, found.id)).returning())[0].id
            : (await tx.insert(productModels).values({ organisationId: orgId, brandId, name: m.name, ...values, leadTimeDays: 10 }).returning())[0].id;
          counts.models++;

          for (const loft of m.lofts ?? []) {
            await upsertComponent({ categoryKey: 'loft', brandId, name: loft, upchargePence: 0, metadata: { modelIds: [modelId] }, mergeModelIds: true });
            counts.lofts++;
          }

          // Set make-ups, priced per model from the per-club price.
          if (isIrons && perClub != null) {
            const baseClubs = Number(/(\d+) clubs?/.exec(m.setMakeup ?? '')?.[1] ?? 6);
            for (const s of SETS) {
              const compId = await upsertComponent({ categoryKey: 'set', brandId: null, name: s.name, upchargePence: 0, metadata: { clubCategories: ['irons'], clubs: s.clubs, modelIds: [modelId] }, mergeModelIds: true });
              const override = (s.clubs - baseClubs) * perClub;
              const [rule] = await tx.select().from(modelComponentRules).where(and(eq(modelComponentRules.modelId, modelId), eq(modelComponentRules.componentId, compId)));
              if (rule) await tx.update(modelComponentRules).set({ upchargeOverridePence: override }).where(eq(modelComponentRules.id, rule.id));
              else await tx.insert(modelComponentRules).values({ organisationId: orgId, modelId, componentId: compId, rule: s.clubs === baseClubs && s.name.startsWith('5-PW (') ? 'default' : 'allowed', upchargeOverridePence: override });
              counts.sets++;
            }
          }
        }

        for (const p of b.shafts) {
          const flex = p.flexes?.length ? ` (${p.flexes.join(', ')})` : '';
          const types = p.clubTypes.filter((t) => SHAFTED.includes(t));
          if (!types.length) continue;
          // Iron shaft upcharges are per club; a flat amount would be wrong for a set, so staff add it.
          const perClubNote = types.includes('irons') && (p.upchargeGBP ?? 0) > 0 ? ` — +£${p.upchargeGBP} per club` : '';
          await upsertComponent({
            categoryKey: 'shaft', brandId, name: `${p.name}${flex}${perClubNote}`, upchargePence: perClubNote ? 0 : (pence(p.upchargeGBP) ?? 0),
            metadata: { clubCategories: types, stock: p.stock ?? null, priceOnRequest: p.upchargeGBP == null, perClubUpchargePence: perClubNote ? pence(p.upchargeGBP) : null },
          });
          counts.shafts++;
        }
        for (const g of b.grips) {
          await upsertComponent({ categoryKey: 'grip', brandId, name: g.name, upchargePence: pence(g.upchargeGBP) ?? 0, metadata: { clubCategories: g.clubTypes, stock: g.stock ?? null, priceOnRequest: g.upchargeGBP == null } });
          counts.grips++;
        }
        report.push(`${b.brand}: ${b.models.length} heads listed, ${b.shafts.length} shafts, ${b.grips.length} grips`);
      }

      await tx.insert(auditEvents).values({
        organisationId: orgId, actorType: 'system', actorLabel: 'Catalogue import', eventType: 'settings_changed', entityType: 'organisation',
        entityId: orgId, newValueJson: counts, metadataJson: { section: 'catalogue.import', file: a.file!.split('/').pop(), skipped },
      });
      report.push(`Totals: ${JSON.stringify(counts)}`);
      if (a['dry-run']) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    report.push('Dry run — nothing was saved.');
  } finally {
    await h.close();
  }
  console.log(report.join('\n'));
  if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`);
}

class DryRun extends Error {}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

