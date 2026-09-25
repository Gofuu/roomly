/**
 * Production demo-data entry point, bundled to dist/seed.js.
 *   node apps/api/dist/seed.js --if-empty     seed the demo companies on a brand-new database
 *   node apps/api/dist/seed.js --reset-demo   nightly: restore the demo companies to a clean state
 */
import { env } from '../../../../scripts/lib/env.js';
import { organizationCount, resetDemo, seed } from '../../../../scripts/seed.js';

const mode = process.argv[2];
if (mode === '--if-empty') {
  if ((await organizationCount(env.dbName)) === 0) {
    await seed(env.dbName);
    console.info('Seeded demo companies.');
  } else {
    console.info('Database already has organizations; not seeding.');
  }
} else if (mode === '--reset-demo') {
  await resetDemo(env.dbName);
  console.info('Demo companies reset.');
} else {
  console.error('usage: node seed.js --if-empty | --reset-demo');
  process.exit(1);
}
