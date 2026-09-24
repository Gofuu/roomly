/**
 *   npm run db:start   — run local Postgres in the foreground (Ctrl+C to stop)
 *   npm run db:reset   — drop + recreate the dev database, migrate, and seed
 */
import { env } from './lib/env.js';
import { ensureServer, setupDatabase } from './lib/pg-admin.js';
import { seed } from './seed.js';

const cmd = process.argv[2];

if (cmd === 'start') {
  const stop = await ensureServer();
  await setupDatabase(env.dbName);
  console.log(`Postgres ready on ${env.host}:${env.port} (database "${env.dbName}"). Ctrl+C to stop.`);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
} else if (cmd === 'reset') {
  const stop = await ensureServer();
  await setupDatabase(env.dbName, { fresh: true });
  await seed(env.dbName);
  await stop();
  console.log(`Database "${env.dbName}" reset and seeded.`);
} else {
  console.error('usage: tsx scripts/db.ts <start|reset>');
  process.exit(1);
}
