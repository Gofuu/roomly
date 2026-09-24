/**
 * Two kinds of token:
 *
 * Access token — a signed JWT (HS256, 15 min). Stateless: the API trusts its
 *   claims (user, org, role) without a database lookup. Held in memory by the web
 *   app, sent as `Authorization: Bearer`. Short-lived because it cannot be revoked.
 *
 * Refresh token — 32 random bytes, opaque, stored server-side only as a SHA-256
 *   hash. Lives in an httpOnly cookie that JavaScript cannot read. Rotated on every
 *   use; see rotateRefreshToken in service.ts for reuse detection.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Role } from '@roomly/shared';
import { config } from '../config.js';

export interface AccessClaims {
  userId: string;
  orgId: string;
  role: Role;
}

const ISSUER = 'roomly';
const AUDIENCE = 'roomly-api';

export function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ org: claims.orgId, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.accessTokenTtlSeconds}s`)
    .sign(config.auth.jwtSecret);
}

/** Returns the claims (plus expiry, in epoch seconds), or null if the token is invalid or expired. */
export async function verifyAccessToken(token: string): Promise<(AccessClaims & { exp: number }) | null> {
  try {
    const { payload } = await jwtVerify(token, config.auth.jwtSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const { sub, org, role, exp } = payload;
    if (typeof sub !== 'string' || typeof org !== 'string' || (role !== 'admin' && role !== 'employee')) return null;
    return { userId: sub, orgId: org, role, exp: exp! };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}

/** A random opaque token (for refresh tokens and invitation links). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are high-entropy random values, so a fast unsalted hash is appropriate (unlike passwords). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
