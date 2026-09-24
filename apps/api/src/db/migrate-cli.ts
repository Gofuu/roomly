/**
 * Production migration entry point, bundled to dist/migrate.js. Run it once per
 * deploy, before the new API version starts (e.g. an ECS one-off task):
 *   node apps/api/dist/migrate.js
 * Needs PG_SUPERUSER/PG_SUPERUSER_PASSWORD (the RDS master user) and the app/system
 * role passwords, which it (re)applies. It does not create the database itself.
 */
import { env } from '../../../../scripts/lib/env.js';
import { ensureRoles, migrate } from '../../../../scripts/lib/migrations.js';

await ensureRoles();
await migrate(env.dbName);
console.info('Migrations up to date.');
