import { defineConfig } from 'vitest/config';
import { env } from './scripts/lib/env.js';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts'],
    globalSetup: ['./scripts/test-global-setup.ts'],
    // Point every worker at the throwaway test database.
    env: {
      DB_NAME: env.testDbName,
      NODE_ENV: 'test',
      // Offline Stripe: webhooks are signed locally with this secret; API calls go to a stub.
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
      STRIPE_PRICE_PRO: 'price_test_pro',
      STRIPE_PRICE_ENTERPRISE: 'price_test_enterprise',
    },
    // Test files share one database and some open many connections at once.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
