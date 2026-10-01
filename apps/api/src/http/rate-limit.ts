import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

/** Limits each IP address on the login/signup endpoints, to slow down password guessing. */
export function authRateLimit(perMinute = config.auth.loginAttemptsPerMinute) {
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
