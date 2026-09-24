import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { closeDb } from './db/index.js';
import { attachRealtime } from './realtime/socket.js';

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
