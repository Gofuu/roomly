/**
 * Database access.
 *
 *   withTenant(orgId, fn) — a transaction pinned to one company. Row-level
 *                           security then limits buildings, floors, rooms and
 *                           bookings to that company's rows.
 *   withDb(fn)            — a plain transaction, for code that runs before a
 *                           company is known (signup, login, invitations, the
 *                           Stripe webhook). The RLS-protected tables look empty
 *                           here, so it can only touch organizations, users,
 *                           invitations and refresh tokens.
 */
import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { config } from '../config.js';
import type { Database } from './types.js';
import { retryTransient } from './retry.js';

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.appUser,
  password: config.db.appPassword,
  max: 20,
});

const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

export type Tx = Transaction<Database>;

/**
 * Runs fn in a transaction that can only see and write orgId's rooms and bookings.
 * The org id is set with is_local = true, so it disappears at COMMIT/ROLLBACK and
 * cannot leak to the next request that borrows the same pooled connection.
 * Retried on deadlock, so fn must be safe to run again.
 */
export function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return retryTransient(() =>
    db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.org_id', ${orgId}, true)`.execute(tx);
      return fn(tx);
    }),
  );
}

export function withDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return retryTransient(() => db.transaction().execute(fn));
}

export async function closeDb() {
  await db.destroy();
}
