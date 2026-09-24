import type { Request, RequestHandler } from 'express';
import { forbidden, unauthorized } from '../http/errors.js';
import { verifyAccessToken, type AccessClaims } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
    }
  }
}

/** Verifies the Bearer access token and attaches its claims as req.auth. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(unauthorized());
  const claims = await verifyAccessToken(token);
  if (!claims) return next(unauthorized('Access token is invalid or expired'));
  req.auth = { userId: claims.userId, orgId: claims.orgId, role: claims.role };
  next();
};

/** Must run after requireAuth. The role comes from the signed token, not the request body. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.auth?.role !== 'admin') return next(forbidden('Only organization admins can do that'));
  next();
};

/** The authenticated claims; throws if a route forgot requireAuth. */
export function auth(req: Request): AccessClaims {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
