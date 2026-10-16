import './env';
import { createDatabase } from '../src/db';
import { DEMO_PASSWORD, DEMO_QUOTE_TOKEN, DEMO_TRACKING_TOKEN, seedDemo } from '../src/db/seed';

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (url && !url.startsWith('pglite:') && !process.argv.includes('--allow-remote')) {
    console.error('Refusing to load demo data into a remote database. Use `npm run shop:create` for a real shop,');
    console.error('or pass --allow-remote if this really is a demo/staging database.');
    process.exit(1);
  }
  const h = createDatabase();
  try {
    const res = await seedDemo(h.db);
    if (res.skipped) {
      console.log('Demo data already present — nothing to do.');
      return;
    }
    const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    console.log('✓ Seeded Desirable Golf demo workspace');
    console.log(`  Sign in: gary@desirablegolf.test (admin) · chris@desirablegolf.test (manager) · will@desirablegolf.test (staff)`);
    console.log(`  Password: ${DEMO_PASSWORD}`);
    console.log(`  Customer tracking page: ${base}/t/${DEMO_TRACKING_TOKEN}`);
    console.log(`  Customer quote approval: ${base}/q/${DEMO_QUOTE_TOKEN}`);
  } finally {
    await h.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
