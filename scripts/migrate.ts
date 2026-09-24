import { env } from './lib/env.js';
import { ensureServer, setupDatabase } from './lib/pg-admin.js';

const stop = await ensureServer();
await setupDatabase(env.dbName);
await stop();
console.log('Migrations up to date.');
