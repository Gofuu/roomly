import { migrate } from '../apps/api/src/db/migrate.js';
import { createDatabase, ensureServer } from './local-postgres.js';

// A fresh test database for every run. Starts Postgres if nothing is listening,
// and stops it again afterwards.
export default async function setup() {
  const stop = await ensureServer();
  const testDb = process.env.TEST_DB_NAME ?? 'roomly_test';
  await createDatabase(testDb, { dropFirst: true });
  await migrate(testDb, () => {});
  return stop;
}
