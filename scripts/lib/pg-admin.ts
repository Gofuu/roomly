/**
 * Database admin helpers shared by the CLI scripts and the test global setup:
 * start a local Postgres if none is running, create roles/databases, run migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { ROOT, env } from './env.js';
import { superClient } from './migrations.js';

export { createDatabase, ensureRoles, migrate, setupDatabase, superClient } from './migrations.js';

const DATA_DIR = path.join(ROOT, '.pgdata');

async function isServerUp(): Promise<boolean> {
  const c = superClient();
  try {
    await c.connect();
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * Ensures a Postgres server is reachable. If nothing is listening (no Docker, no
 * `npm run db:start`), boots the embedded server and returns a function that stops it.
 */
export async function ensureServer(): Promise<() => Promise<void>> {
  if (await isServerUp()) return async () => {};

  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: env.superuser,
    password: env.superuserPassword,
    port: env.port,
    persistent: true,
    // Without this, initdb on Windows inherits the OS code page (WIN1252).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    await server.initialise();
  }
  await server.start();
  return () => server.stop();
}

