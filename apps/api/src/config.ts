import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
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
    appUser: required('APP_DB_USER'),
    appPassword: required('APP_DB_PASSWORD'),
    systemUser: required('SYSTEM_DB_USER'),
    systemPassword: required('SYSTEM_DB_PASSWORD'),
  },
  apiPort: Number(process.env.API_PORT ?? 4000),
  webOrigin: required('WEB_ORIGIN'),
  auth: {
    jwtSecret: new TextEncoder().encode(required('JWT_SECRET')),
    accessTokenTtlSeconds: Number(required('ACCESS_TOKEN_TTL_SECONDS')),
    refreshTokenTtlDays: Number(required('REFRESH_TOKEN_TTL_DAYS')),
    inviteTtlDays: Number(required('INVITE_TTL_DAYS')),
  },
};

export const isProduction = config.env === 'production';

if (isProduction && process.env.JWT_SECRET!.startsWith('dev-only')) {
  throw new Error('Refusing to start in production with the development JWT_SECRET');
}
