import './env';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db';
import { auditEvents, organisations } from '../src/db/schema';
import { DESIRABLE_GOLF_BRAND } from '../src/db/seed';

/** One-off: apply Desirable Golf's website branding to its live workspace (audited). */
async function main() {
  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  try {
    const [org] = await h.db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
    if (!org) throw new Error('desirable-golf workspace not found');
    await h.db.transaction(async (tx) => {
      await tx.update(organisations).set(DESIRABLE_GOLF_BRAND).where(eq(organisations.id, org.id));
      await tx.insert(auditEvents).values({
        organisationId: org.id, entityType: 'organisation', entityId: org.id, actorType: 'system', actorLabel: 'COS setup',
        eventType: 'settings_changed', oldValueJson: { brandColor: org.brandColor, brandTheme: org.brandTheme },
        newValueJson: DESIRABLE_GOLF_BRAND, metadataJson: { section: 'branding' },
      });
    });
    console.log('✓ Desirable Golf branding applied');
  } finally {
    await h.close();
  }
}
main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
