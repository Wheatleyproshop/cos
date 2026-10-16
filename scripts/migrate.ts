import './env';
import { runMigrations } from '../src/db/migrate';

runMigrations()
  .then(() => {
    console.log('✓ Migrations applied');
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
