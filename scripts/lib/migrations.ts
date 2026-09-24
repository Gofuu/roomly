/**
 * Roles, databases and migrations. Plain `pg` only, so it can be bundled into
 * the production image (see apps/api/src/db/migrate-cli.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT, env } from './env.js';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.join(ROOT, 'db', 'migrations');

export function superClient(database = 'postgres') {
  return new pg.Client({
    host: env.host,
    port: env.port,
    user: env.superuser,
    password: env.superuserPassword,
    database,
  });
}

/** Creates the login roles (idempotent). Roles are cluster-wide, not per database. */
export async function ensureRoles() {
  const c = superClient();
  await c.connect();
  try {
    // Plain login roles. Neither is a superuser or has BYPASSRLS; what each may
    // see is decided by grants and RLS policies in the migrations (002, 007).
    //  - app role: the API's everyday role, always tenant-filtered.
    //  - system role: pre-tenant paths (login, refresh, webhooks, calendar worker).
    for (const [name, password] of [[env.appUser, env.appPassword], [env.systemUser, env.systemPassword]] as const) {
      const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await c.query(`${verb} ROLE ${pg.escapeIdentifier(name)} LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
    }
  } finally {
    await c.end();
  }
}

export async function createDatabase(name: string, { dropFirst = false } = {}) {
  const c = superClient();
  await c.connect();
  try {
    if (dropFirst) await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  } finally {
    await c.end();
  }
}

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * recording applied files in schema_migrations. Migrations run as the superuser,
 * so tables are owned by it — the app roles only get the grants the SQL gives them.
 */
export async function migrate(database: string, log = console.log) {
  const c = superClient(database);
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set(
      (await c.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        .replaceAll(':app_user', pg.escapeIdentifier(env.appUser))
        .replaceAll(':system_user', pg.escapeIdentifier(env.systemUser));
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await c.query('COMMIT');
        log(`  applied ${file}`);
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
}

/** Full setup for one database: roles, database, migrations. */
export async function setupDatabase(name: string, opts: { fresh?: boolean; log?: (m: string) => void } = {}) {
  await ensureRoles();
  await createDatabase(name, { dropFirst: opts.fresh });
  await migrate(name, opts.log);
}
