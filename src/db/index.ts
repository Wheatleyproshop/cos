import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/** Works for both drivers; transactions are also assignable to this type. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

type Handle = { db: DB; driver: 'pglite' | 'postgres'; close: () => Promise<void> };

export function createDatabase(url = process.env.DATABASE_URL ?? ''): Handle {
  if (!url || url.startsWith('pglite:')) {
    // Embedded Postgres for local development and tests — no install required.
    const dataDir = url.startsWith('pglite:') ? url.slice('pglite:'.length) : './.data/pglite';
    if (!dataDir.includes('://')) mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
    const client = new PGlite(dataDir);
    return {
      db: drizzlePglite(client, { schema }) as unknown as DB,
      driver: 'pglite',
      close: () => client.close(),
    };
  }
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 5), prepare: false });
  return {
    db: drizzlePostgres(client, { schema }) as unknown as DB,
    driver: 'postgres',
    close: () => client.end(),
  };
}

const globalForDb = globalThis as unknown as { __cosDb?: Handle };

function handle(): Handle {
  globalForDb.__cosDb ??= createDatabase();
  return globalForDb.__cosDb;
}

/**
 * Owner-role connection. Bypasses row-level security, so it is ONLY used for:
 * authentication, resolving public customer tokens, webhooks and cron jobs.
 * Everything a staff member does goes through `withTenant`.
 */
export function systemDb(): DB {
  return handle().db;
}

/** For tests: swap the global handle. */
export function setDatabaseHandle(h: Handle) {
  globalForDb.__cosDb = h;
}

/**
 * Run `fn` in a transaction scoped to one organisation. Inside it the
 * connection drops to the `cos_app` role, so Postgres RLS policies reject any
 * row that does not belong to `organisationId`, even if a query forgets to filter.
 */
export async function withTenant<T>(organisationId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(organisationId)) throw new Error('Invalid organisation id');
  return handle().db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${organisationId}, true)`);
    await tx.execute(sql`set local role cos_app`);
    return fn(tx as unknown as DB);
  });
}

export { schema };
