import './env';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, setDatabaseHandle, withTenant } from '../src/db';
import { organisations } from '../src/db/schema';
import { buildExport } from '../src/lib/services/backups';

/**
 * Saves a full JSON copy of every workspace to this Mac (default: ~/Documents/COS Backups).
 *   npm run backup:local -- [--dir "/path/to/folder"]
 * Uses DATABASE_URL_UNPOOLED / DATABASE_URL (e.g. from .env.production.local).
 */
async function main() {
  const i = process.argv.indexOf('--dir');
  const dir = i > -1 ? process.argv[i + 1] : path.join(os.homedir(), 'Documents', 'COS Backups');
  mkdirSync(dir, { recursive: true });
  const h = createDatabase(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  setDatabaseHandle(h);
  try {
    const orgs = await h.db.select({ id: organisations.id, slug: organisations.slug }).from(organisations);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    for (const o of orgs) {
      const data = await withTenant(o.id, (tx) => buildExport(tx, o.id));
      const file = path.join(dir, `${o.slug}-${stamp}.json`);
      writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      console.log(`✓ ${o.slug}: ${data.orders.length} orders, ${data.customers.length} customers → ${file}`);
    }
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
