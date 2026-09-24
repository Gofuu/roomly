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
      // Offline Google: OAuth and Calendar calls go to a stub client.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      // Every test request comes from 127.0.0.1; the limiter itself is tested separately.
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    },
    // Test files share one database and some open many connections at once.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
