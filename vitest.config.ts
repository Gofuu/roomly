import { defineConfig } from 'vitest/config';
import { env } from './scripts/lib/env.js';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts'],
    globalSetup: ['./scripts/test-global-setup.ts'],
    // Point every worker at the throwaway test database.
    env: { DB_NAME: env.testDbName, NODE_ENV: 'test' },
    // Test files share one database and some open many connections at once.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
