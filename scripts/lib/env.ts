import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// .env wins; .env.example supplies defaults so a fresh clone works without setup.
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '.env.example') });

export const env = {
  host: process.env.PGHOST!,
  port: Number(process.env.PGPORT),
  superuser: process.env.PG_SUPERUSER!,
  superuserPassword: process.env.PG_SUPERUSER_PASSWORD!,
  dbName: process.env.DB_NAME!,
  testDbName: process.env.TEST_DB_NAME!,
  appUser: process.env.APP_DB_USER!,
  appPassword: process.env.APP_DB_PASSWORD!,
  systemUser: process.env.SYSTEM_DB_USER!,
  systemPassword: process.env.SYSTEM_DB_PASSWORD!,
};
