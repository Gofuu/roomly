import { defineConfig } from 'vitest/config';

const TEST_DB = 'roomly_test';
process.env.TEST_DB_NAME = TEST_DB; // read by the global setup, which creates this database

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts'],
    globalSetup: ['./scripts/test-global-setup.ts'],
    env: {
      DB_NAME: TEST_DB, // every test talks to the throwaway database
      NODE_ENV: 'test',
      // Stripe is never called in tests: webhooks are signed locally with this secret.
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
      STRIPE_PRICE_PRO: 'price_test_pro',
      STRIPE_PRICE_ENTERPRISE: 'price_test_enterprise',
      // All test requests come from 127.0.0.1, so the login rate limit is lifted.
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    },
    // The test files share one database, so run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
