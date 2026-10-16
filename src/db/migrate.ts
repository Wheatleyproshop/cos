import path from 'node:path';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './index';

/** Uses the direct (unpooled) connection when available — DDL through a pooler is unreliable. */
export async function runMigrations(url?: string, opts: { keepOpen?: boolean } = {}) {
  const h = createDatabase(url ?? (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL));
  const migrationsFolder = path.join(process.cwd(), 'drizzle');
  if (h.driver === 'pglite') {
    await migratePglite(h.db as never, { migrationsFolder });
  } else {
    await migratePostgres(h.db as never, { migrationsFolder });
  }
  if (!opts.keepOpen) await h.close();
  return h;
}
