import './env';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/db';
import { auditEvents, organisations, users } from '../src/db/schema';

/**
 * Creates a retailer workspace and its first Owner/Admin. Run once per shop:
 *   npm run shop:create -- --name "Desirable Golf" --reply-to orders@example.com \
 *     --location "Wheatley Golf Club, Doncaster" --owner-name "Jane Smith" --owner-email jane@example.com
 * Prints a one-time temporary password for the owner.
 */
async function main() {
  const { values: a } = parseArgs({
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      'reply-to': { type: 'string' },
      location: { type: 'string', default: '' },
      'owner-name': { type: 'string' },
      'owner-email': { type: 'string' },
      plan: { type: 'string', default: 'trial' },
    },
  });
  const missing = ['name', 'reply-to', 'owner-name', 'owner-email'].filter((k) => !a[k as keyof typeof a]);
  if (missing.length) throw new Error(`Missing --${missing.join(', --')}`);
  if (!['trial', 'core', 'pro'].includes(a.plan!)) throw new Error('--plan must be trial, core or pro');
  const slug = a.slug ?? a.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const password = randomBytes(9).toString('base64url');

  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  try {
    await h.db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${a['owner-email']!.toLowerCase()}`);
      if (taken) throw new Error(`${a['owner-email']} already has a COS account.`);
      const [org] = await tx
        .insert(organisations)
        .values({
          name: a.name!, slug, storeName: a.name!, replyToEmail: a['reply-to']!, collectionLocation: a.location!,
          plan: a.plan as 'trial', trialEndsAt: a.plan === 'trial' ? new Date(Date.now() + 30 * 86_400_000) : null,
        })
        .returning();
      const [owner] = await tx
        .insert(users)
        .values({ organisationId: org.id, name: a['owner-name']!, email: a['owner-email']!.toLowerCase(), role: 'admin', passwordHash: await bcrypt.hash(password, 12) })
        .returning();
      await tx.insert(auditEvents).values({
        organisationId: org.id, entityType: 'organisation', entityId: org.id, actorType: 'system', actorLabel: 'COS setup',
        eventType: 'settings_changed', newValueJson: { created: true, owner: owner.email }, metadataJson: { section: 'workspace_created' },
      });
    });
    console.log(`✓ Created "${a.name}" (${slug})`);
    console.log(`  Owner: ${a['owner-name']} <${a['owner-email']}>`);
    console.log(`  Temporary password: ${password}`);
    console.log('  Sign in and change it under Store settings → Your account.');
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
