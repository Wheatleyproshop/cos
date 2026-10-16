import './env';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db';
import { auditEvents, organisations } from '../src/db/schema';

/**
 * Change a workspace's plan (operator tool; there is no billing yet). Audited.
 *   npm run plan:set -- --slug desirable-golf --plan pro
 * Trial plans get --trial-days (default 30); other plans never expire.
 */
async function main() {
  const { values: a } = parseArgs({ options: { slug: { type: 'string' }, plan: { type: 'string' }, 'trial-days': { type: 'string', default: '30' } } });
  if (!a.slug || !['trial', 'core', 'pro'].includes(a.plan ?? '')) throw new Error('Usage: --slug <workspace> --plan trial|core|pro');
  const plan = a.plan as 'trial' | 'core' | 'pro';
  const trialEndsAt = plan === 'trial' ? new Date(Date.now() + Number(a['trial-days']) * 86_400_000) : null;
  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  try {
    const [org] = await h.db.select().from(organisations).where(eq(organisations.slug, a.slug));
    if (!org) throw new Error(`Workspace ${a.slug} not found`);
    await h.db.transaction(async (tx) => {
      await tx.update(organisations).set({ plan, trialEndsAt }).where(eq(organisations.id, org.id));
      await tx.insert(auditEvents).values({
        organisationId: org.id, entityType: 'organisation', entityId: org.id, actorType: 'system', actorLabel: 'COS operator',
        eventType: 'settings_changed', oldValueJson: { plan: org.plan, trialEndsAt: org.trialEndsAt },
        newValueJson: { plan, trialEndsAt }, metadataJson: { section: 'plan' },
      });
    });
    console.log(`✓ ${org.name}: ${org.plan} → ${plan}${trialEndsAt ? ` (trial ends ${trialEndsAt.toDateString()})` : ' (no expiry)'}`);
  } finally {
    await h.close();
  }
}
main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
