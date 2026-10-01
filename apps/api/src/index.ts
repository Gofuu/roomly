import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { attachRealtime } from './realtime/socket.js';

// In production the container sets the database up itself on start.
if (process.env.RUN_MIGRATIONS === 'true') {
  await migrate();
  if (process.env.SEED_DEMO_DATA === 'true' && (await seed(config.db.database, { onlyIfEmpty: true }))) {
    console.info('Added demo data.');
  }
}

const server = createServer(createApp());
const realtime = attachRealtime(server);

server.listen(config.apiPort, () => {
  console.info(`API listening on http://localhost:${config.apiPort}`);
});

async function shutdown() {
  await realtime.close();
  server.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
