/**
 * Two database handles, deliberately different:
 *
 *   withTenant(orgId, fn)  — the default. Connects as the low-privilege app role
 *                            and pins the transaction to one org, so Row-Level
 *                            Security filters every query to that tenant.
 *   withSystem(fn)         — the privileged role, allowed across tenants by the
 *                            system_access policies (migration 007). Only for code
 *                            that runs before a tenant is known or spans tenants:
 *                            signup, login, token refresh, invite acceptance,
 *                            webhooks, the calendar worker.
 */
import pg from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { config } from '../config.js';
import type { Database } from './types.js';
import { retryTransient } from './retry.js';

// Return `date` columns as plain 'YYYY-MM-DD' strings instead of shifting them into local-time Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const base = { host: config.db.host, port: config.db.port, database: config.db.database };

export const appPool = new pg.Pool({ ...base, user: config.db.appUser, password: config.db.appPassword, max: 20 });
export const systemPool = new pg.Pool({
  ...base, user: config.db.systemUser, password: config.db.systemPassword, max: 5,
});

const appDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: appPool }) });
const systemDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: systemPool }) });

export type Tx = Transaction<Database>;

/**
 * Runs fn in a transaction whose queries can only see and write orgId's rows.
 * The org id is set with is_local = true, so it disappears at COMMIT/ROLLBACK and
 * cannot leak to the next request that borrows the same pooled connection.
 * Retried on deadlock/serialization failure, so fn must be safe to re-run.
 */
export function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return retryTransient(() =>
    appDb.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.org_id', ${orgId}, true)`.execute(tx);
      return fn(tx);
    }),
  );
}

/** Privileged cross-tenant transaction. See the file comment before using it. */
export function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return retryTransient(() => systemDb.transaction().execute(fn));
}

export async function closeDb() {
  await Promise.all([appDb.destroy(), systemDb.destroy()]);
}
