import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { closeDb } from './db/index.js';
import { attachRealtime } from './realtime/socket.js';
import { startCalendarWorker } from './integrations/calendar-worker.js';

const server = createServer(createApp());
const realtime = attachRealtime(server);
// In production this would run as its own process; SKIP LOCKED makes several workers safe.
const stopCalendarWorker = startCalendarWorker();

server.listen(config.apiPort, () => {
  console.info(`API listening on http://localhost:${config.apiPort}`);
});

async function shutdown() {
  stopCalendarWorker();
  await realtime.close();
  server.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
