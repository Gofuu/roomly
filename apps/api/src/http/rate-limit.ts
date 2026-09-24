import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

/**
 * Per-IP limits on the unauthenticated endpoints an attacker would hammer
 * (password guessing, signup spam, invite-token guessing). The in-memory
 * store is per instance. With several instances behind a load balancer,
 * use a shared store (e.g. Redis or Postgres) so limits add up across them.
 */
export function authRateLimit(perMinute = config.rateLimit.authPerMinute) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute and try again.' } });
    },
  });
}
