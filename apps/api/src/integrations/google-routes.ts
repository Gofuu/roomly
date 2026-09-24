/**
 * Per-user Google Calendar connection (OAuth 2.0 authorization-code flow).
 *
 * 1. POST /connect (authenticated): we mint a signed `state` naming this user, and
 *    set a matching random nonce in an httpOnly cookie. We return Google's consent URL.
 * 2. Google redirects the browser to GET /callback?code&state. That request has
 *    no Authorization header (it's a top-level navigation), so the user comes
 *    from the signed state. The cookie nonce proves the same browser started the flow.
 * 3. We exchange the code for a refresh token, encrypt it, store it, and queue
 *    the user's upcoming bookings for sync.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type CookieOptions } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import { config, isProduction } from '../config.js';
import { withSystem, withTenant } from '../db/index.js';
import { auth } from '../auth/middleware.js';
import { HttpError } from '../http/errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { google } from './google-client.js';

const NONCE_COOKIE = 'roomly_google_nonce';
const nonceCookie: CookieOptions = {
  httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/api/integrations/google', maxAge: 10 * 60_000,
};

function clientOrThrow() {
  if (!google.client) {
    throw new HttpError(503, 'GOOGLE_NOT_CONFIGURED', 'Google Calendar is not configured on this server (missing GOOGLE_CLIENT_ID/SECRET)');
  }
  return google.client;
}

const signState = (p: { userId: string; orgId: string; nonce: string }) =>
  new SignJWT({ org: p.orgId, nonce: p.nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.userId)
    .setAudience('google-oauth')
    .setExpirationTime('10m')
    .sign(config.auth.jwtSecret);

const redirectToSettings = (result: string) => `${config.webOrigin}/settings?google=${result}`;

/** Public: Google redirects the browser here. Mounted before requireAuth. */
export const googleCallbackRouter = Router();

googleCallbackRouter.get('/callback', async (req, res) => {
  const cookieNonce: unknown = req.cookies?.[NONCE_COOKIE];
  res.clearCookie(NONCE_COOKIE, nonceCookie);
  if (typeof req.query.error === 'string') return res.redirect(redirectToSettings('denied'));

  let claims: { sub?: string; org?: unknown; nonce?: unknown };
  try {
    ({ payload: claims } = await jwtVerify(String(req.query.state ?? ''), config.auth.jwtSecret, { audience: 'google-oauth' }));
  } catch {
    return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
  }
  const nonceOk = typeof cookieNonce === 'string' && typeof claims.nonce === 'string'
    && cookieNonce.length === claims.nonce.length
    && timingSafeEqual(Buffer.from(cookieNonce), Buffer.from(claims.nonce));
  if (!nonceOk) return res.status(400).send('This connection was started in a different browser. Please try again.');

  const userId = claims.sub!;
  const orgId = String(claims.org);
  try {
    const { refreshToken, email, scopes } = await clientOrThrow().exchangeCode(String(req.query.code ?? ''));
    await withSystem(async (tx) => {
      const user = await tx.selectFrom('users').select('id').where('id', '=', userId).where('org_id', '=', orgId)
        .where('is_active', '=', true).executeTakeFirst();
      if (!user) throw new HttpError(403, 'FORBIDDEN', 'User is no longer active');
      const row = {
        google_email: email, refresh_token_enc: encryptSecret(refreshToken), scopes, connected_at: sql<Date>`now()`,
      };
      await tx.insertInto('google_connections').values({ user_id: userId, org_id: orgId, ...row })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(row)).execute();
      // Backfill: put the user's upcoming bookings on their calendar too.
      await sql`
        INSERT INTO calendar_sync_outbox (org_id, booking_id, user_id, action)
        SELECT org_id, id, user_id, 'upsert' FROM bookings
         WHERE user_id = ${userId} AND status = 'confirmed' AND upper(during) > now()`.execute(tx);
    });
    res.redirect(redirectToSettings('connected'));
  } catch (err) {
    console.error('[google] callback failed', err);
    res.redirect(redirectToSettings('error'));
  }
});

/** Authenticated routes. */
export const googleRouter = Router();

googleRouter.get('/', async (req, res) => {
  const { orgId, userId } = auth(req);
  const row = await withTenant(orgId, (tx) =>
    tx.selectFrom('google_connections').select(['google_email', 'connected_at']).where('user_id', '=', userId).executeTakeFirst(),
  );
  const pending = await withTenant(orgId, (tx) =>
    tx.selectFrom('calendar_sync_outbox')
      .select([sql<number>`count(*) FILTER (WHERE done_at IS NULL)::int`.as('pending'),
        sql<number>`count(*) FILTER (WHERE done_at IS NOT NULL AND last_error IS NOT NULL AND created_at > now() - interval '1 day')::int`.as('failed')])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
  );
  res.json({
    configured: !!google.client,
    connected: !!row,
    email: row?.google_email ?? null,
    connectedAt: row?.connected_at.toISOString() ?? null,
    pendingSyncs: pending.pending,
    recentFailures: pending.failed,
  });
});

googleRouter.post('/connect', async (req, res) => {
  const { orgId, userId } = auth(req);
  const client = clientOrThrow();
  const nonce = randomBytes(16).toString('base64url');
  res.cookie(NONCE_COOKIE, nonce, nonceCookie);
  res.json({ url: client.authUrl(await signState({ userId, orgId, nonce })) });
});

googleRouter.delete('/', async (req, res) => {
  const { orgId, userId } = auth(req);
  const row = await withSystem((tx) =>
    tx.deleteFrom('google_connections').where('user_id', '=', userId).where('org_id', '=', orgId)
      .returning('refresh_token_enc').executeTakeFirst(),
  );
  // Best effort: also revoke the grant on Google's side.
  if (row && google.client) await google.client.revoke(decryptSecret(row.refresh_token_enc)).catch(() => {});
  res.status(204).end();
});
