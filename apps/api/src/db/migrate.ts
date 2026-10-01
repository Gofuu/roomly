/**
 * Creates the app's database role and applies db/migrations/*.sql in order.
 * Connects as the owner role, never as the app role.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

export function ownerClient(database: string) {
  return new pg.Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.superuser,
    password: config.db.superuserPassword,
    database,
  });
}

/** Creates the login role the API runs as, or updates its password. */
async function ensureAppRole(c: pg.Client) {
  const name = pg.escapeIdentifier(config.db.appUser);
  const password = pg.escapeLiteral(config.db.appPassword);
  const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [config.db.appUser]);
  await c.query(`${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${name} LOGIN PASSWORD ${password}`);
}

/** Applies every migration file that has not run yet, each in its own transaction. */
export async function migrate(database = config.db.database, log: (line: string) => void = console.info) {
  const c = ownerClient(database);
  await c.connect();
  try {
    await ensureAppRole(c);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await c.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = fs.readdirSync(config.db.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(config.db.migrationsDir, file), 'utf8')
        .replaceAll(':app_user', pg.escapeIdentifier(config.db.appUser));
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await c.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
}
