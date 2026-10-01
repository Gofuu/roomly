import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// .env wins; .env.example supplies defaults. Already-set process env vars win over both.
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '.env.example') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  db: {
    host: required('PGHOST'),
    port: Number(required('PGPORT')),
    database: required('DB_NAME'),
    // The role the API runs as. Subject to row-level security.
    appUser: required('APP_DB_USER'),
    appPassword: required('APP_DB_PASSWORD'),
    // Owner role, used only to create the app role and run migrations.
    superuser: required('PG_SUPERUSER'),
    superuserPassword: required('PG_SUPERUSER_PASSWORD'),
    migrationsDir: process.env.MIGRATIONS_DIR ?? path.join(ROOT, 'db', 'migrations'),
  },
  apiPort: Number(process.env.API_PORT ?? 4000),
  webOrigin: required('WEB_ORIGIN'),
  /** Folder with the built web app. Set in production, where the API also serves the site. */
  webDistDir: process.env.WEB_DIST_DIR || null,
  auth: {
    jwtSecret: new TextEncoder().encode(required('JWT_SECRET')),
    accessTokenTtlSeconds: Number(required('ACCESS_TOKEN_TTL_SECONDS')),
    refreshTokenTtlDays: Number(required('REFRESH_TOKEN_TTL_DAYS')),
    inviteTtlDays: Number(required('INVITE_TTL_DAYS')),
    loginAttemptsPerMinute: Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? 20),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    /** plan id → Stripe price id */
    prices: {
      pro: process.env.STRIPE_PRICE_PRO || null,
      enterprise: process.env.STRIPE_PRICE_ENTERPRISE || null,
    } as Record<string, string | null>,
  },
};

export const isProduction = config.env === 'production';

if (isProduction && process.env.JWT_SECRET!.startsWith('dev-only')) {
  throw new Error('Refusing to start in production with the development JWT_SECRET');
}
