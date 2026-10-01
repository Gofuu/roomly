/**
 * Two kinds of token:
 *
 * Access token: a signed JWT that lasts 15 minutes. The API trusts its claims
 *   (user, company, role) without a database lookup. The web app keeps it in
 *   memory and sends it as `Authorization: Bearer`.
 *
 * Refresh token: 32 random bytes, stored in the database only as a SHA-256
 *   hash. It lives in an httpOnly cookie that JavaScript cannot read, and is
 *   swapped for a new one every time it is used.
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

/** Returns the claims, or null if the token is invalid or expired. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config.auth.jwtSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const { sub, org, role } = payload;
    if (typeof sub !== 'string' || typeof org !== 'string' || (role !== 'admin' && role !== 'employee')) return null;
    return { userId: sub, orgId: org, role };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}

/** A random token for refresh cookies and invitation links. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** These tokens are long random values, so a plain fast hash is enough (unlike passwords). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
