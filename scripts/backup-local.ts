import './env';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, setDatabaseHandle, withTenant } from '../src/db';
import { organisations } from '../src/db/schema';
import { buildExport } from '../src/lib/services/backups';

/**
 * Saves a full JSON copy of every workspace to this Mac (default: ~/Documents/COS Backups).
 *   npm run backup:local -- [--dir "/path/to/folder"] [--keep 52]
 * Keeps the newest --keep copies per workspace (default 52) and removes older ones.
 * Uses DATABASE_URL_UNPOOLED / DATABASE_URL (e.g. from .env.production.local).
 */
async function main() {
  const i = process.argv.indexOf('--dir');
  const dir = i > -1 ? process.argv[i + 1] : path.join(os.homedir(), 'Documents', 'COS Backups');
  const k = process.argv.indexOf('--keep');
  const keep = Math.max(1, k > -1 ? Number(process.argv[k + 1]) || 52 : 52);
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
      const old = readdirSync(dir)
        .filter((f) => f.startsWith(`${o.slug}-`) && f.endsWith('.json'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        .slice(keep);
      for (const f of old) unlinkSync(f);
      if (old.length) console.log(`  removed ${old.length} older cop${old.length === 1 ? 'y' : 'ies'}`);
    }
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
