import './env';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/db';
import { auditEvents, organisations, users } from '../src/db/schema';
import { PLANS } from '../src/lib/plans';

/**
 * Adds a staff account to a workspace and prints a one-time temporary password.
 *   npm run staff:add -- --shop desirable-golf --name "Chris Long" --email chris@example.com --role manager [--no-login]
 *   npm run staff:add -- --shop desirable-golf --name "Pro Shop" --email proshop@example.com --shared
 * Roles: staff | manager | admin. --no-login: member picks their name on the shared login (no password).
 * --shared: a counter login that asks "Who's working?". (Admins can also add people in Store settings → Team.)
 */
async function main() {
  const { values: a } = parseArgs({
    options: {
      shop: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', default: 'staff' },
      'no-login': { type: 'boolean', default: false }, shared: { type: 'boolean', default: false },
    },
  });
  if (!a.shop || !a.name || !a.email) throw new Error('Usage: --shop <slug> --name "Full Name" --email <address> [--role staff|manager|admin]');
  if (!['staff', 'manager', 'admin'].includes(a.role!)) throw new Error('--role must be staff, manager or admin');
  const email = a.email.trim().toLowerCase();
  const password = randomBytes(9).toString('base64url');
  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  try {
    await h.db.transaction(async (tx) => {
      const [org] = await tx.select().from(organisations).where(eq(organisations.slug, a.shop!));
      if (!org) throw new Error(`Workspace ${a.shop} not found`);
      const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (taken) throw new Error(`${email} already has a COS account`);
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.organisationId, org.id), eq(users.active, true)));
      if (n >= PLANS[org.plan].staffLimit) throw new Error(`The ${PLANS[org.plan].label} plan allows ${PLANS[org.plan].staffLimit} active accounts`);
      const [u] = await tx
        .insert(users)
        .values({
          organisationId: org.id, name: a.name!.trim(), email, role: a.role as 'staff', passwordHash: await bcrypt.hash(password, 12),
          loginEnabled: !a['no-login'], sharedLogin: Boolean(a.shared),
        })
        .returning();
      await tx.insert(auditEvents).values({
        organisationId: org.id, entityType: 'user', entityId: u.id, actorType: 'system', actorLabel: 'COS operator',
        eventType: 'user_created', newValueJson: { name: u.name, email: u.email, role: u.role, ownLogin: u.loginEnabled, sharedLogin: u.sharedLogin },
      });
    });
    if (a.shared) console.log(`✓ Shared login "${a.name}" <${email}> created`);
    else console.log(`✓ ${a.name} added as ${a.role}${a['no-login'] ? ' (picks their name on the shared login)' : ` <${email}>`}`);
    if (!a['no-login']) console.log(`  Temporary password: ${password}`);
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
