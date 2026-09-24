import { env } from './lib/env.js';
import { ensureServer, setupDatabase } from './lib/pg-admin.js';

// Fresh test database per run: drop, recreate, migrate. Starts embedded Postgres
// if nothing is listening, and stops it again afterwards.
export default async function setup() {
  const stop = await ensureServer();
  await setupDatabase(env.testDbName, { fresh: true, log: () => {} });
  return stop;
}
