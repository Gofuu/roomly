/**
 * Local PostgreSQL for development and tests, without Docker: the
 * embedded-postgres package ships real Postgres binaries. If something is
 * already listening on the configured port (for example `docker compose up`),
 * that server is used instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { ROOT, config } from '../apps/api/src/config.js';
import { ownerClient } from '../apps/api/src/db/migrate.js';

const DATA_DIR = path.join(ROOT, '.pgdata');

async function isServerUp(): Promise<boolean> {
  const c = ownerClient('postgres');
  try {
    await c.connect();
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Makes sure a server is running. Returns a function that stops it if we started it. */
export async function ensureServer(): Promise<() => Promise<void>> {
  if (await isServerUp()) return async () => {};

  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: config.db.superuser,
    password: config.db.superuserPassword,
    port: config.db.port,
    persistent: true,
    // Without this, initdb on Windows inherits the OS code page (WIN1252).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) await server.initialise();
  await server.start();
  return () => server.stop();
}

export async function createDatabase(name: string, { dropFirst = false } = {}) {
  const c = ownerClient('postgres');
  await c.connect();
  try {
    if (dropFirst) await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  } finally {
    await c.end();
  }
}
