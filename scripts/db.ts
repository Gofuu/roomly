/**
 *   npm run db:start   run local Postgres in the foreground (Ctrl+C to stop)
 *   npm run db:reset   drop and recreate the dev database, migrate, add demo data
 */
import { config } from '../apps/api/src/config.js';
import { migrate } from '../apps/api/src/db/migrate.js';
import { seed } from '../apps/api/src/db/seed.js';
import { createDatabase, ensureServer } from './local-postgres.js';

const command = process.argv[2];
const stop = await ensureServer();

if (command === 'start') {
  await createDatabase(config.db.database);
  await migrate();
  console.info(`Postgres ready on ${config.db.host}:${config.db.port} (database "${config.db.database}"). Ctrl+C to stop.`);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
} else if (command === 'reset') {
  await createDatabase(config.db.database, { dropFirst: true });
  await migrate();
  await seed();
  await stop();
  console.info(`Database "${config.db.database}" reset with demo data.`);
} else {
  console.error('usage: tsx scripts/db.ts <start|reset>');
  process.exit(1);
}
