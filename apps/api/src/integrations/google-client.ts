/**
 * The only module that talks to Google. Plain fetch against the documented REST
 * endpoints (no SDK). Everything else depends on the GoogleClient interface, so
 * tests use a stub and run offline.
 */
import { config } from '../config.js';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

export interface CalendarEvent {
  summary: string;
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

/** Google said the refresh token is no longer valid (revoked, expired, password change). */
export class GoogleAuthRevokedError extends Error {}

export interface GoogleClient {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; email: string; scopes: string }>;
  accessToken(refreshToken: string): Promise<{ token: string; expiresIn: number }>;
  /** Creates or replaces the event with this id (idempotent). */
  upsertEvent(accessToken: string, eventId: string, event: CalendarEvent): Promise<void>;
  /** Deletes the event; succeeds if it is already gone. */
  deleteEvent(accessToken: string, eventId: string): Promise<void>;
  revoke(refreshToken: string): Promise<void>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function check(res: Response, what: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`Google ${what} failed: ${res.status} ${body.slice(0, 300)}`);
}

function httpGoogleClient(clientId: string, clientSecret: string, redirectUri: string): GoogleClient {
  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline', // we need a refresh token to sync later, without the user present
        prompt: 'consent', // ...and Google only re-issues one on explicit consent
        include_granted_scopes: 'true',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },

    async exchangeCode(code) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code',
        }),
      });
      await check(res, 'token exchange');
      const body = (await res.json()) as { refresh_token?: string; id_token?: string; scope: string };
      if (!body.refresh_token) throw new Error('Google did not return a refresh token');
      // The id_token came straight from Google's token endpoint over TLS, so OIDC
      // lets us read its claims without verifying the signature.
      const claims = JSON.parse(Buffer.from(body.id_token!.split('.')[1]!, 'base64url').toString()) as { email: string };
      return { refreshToken: body.refresh_token, email: claims.email, scopes: body.scope };
    },

    async accessToken(refreshToken) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token',
        }),
      });
      if (res.status === 400 || res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'invalid_grant') throw new GoogleAuthRevokedError('Google access was revoked');
      }
      await check(res, 'token refresh');
      const body = (await res.json()) as { access_token: string; expires_in: number };
      return { token: body.access_token, expiresIn: body.expires_in };
    },

    async upsertEvent(accessToken, eventId, event) {
      const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
      const body = JSON.stringify({ ...event, status: 'confirmed' });
      // Update first. An event we deleted earlier still exists as "cancelled" and
      // is restored by an update, while inserting its id again would conflict.
      const update = await fetch(`${EVENTS_URL}/${eventId}`, { method: 'PUT', headers, body });
      if (update.status !== 404) return check(update, 'event update');
      const insert = await fetch(EVENTS_URL, { method: 'POST', headers, body: JSON.stringify({ id: eventId, ...event }) });
      await check(insert, 'event insert');
    },

    async deleteEvent(accessToken, eventId) {
      const res = await fetch(`${EVENTS_URL}/${eventId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 404 || res.status === 410) return;
      await check(res, 'event delete');
    },

    async revoke(refreshToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
    },
  };
}

/** Null until GOOGLE_CLIENT_ID/SECRET are set. Mutable so tests can install a stub. */
export const google: { client: GoogleClient | null } = {
  client: config.google.clientId && config.google.clientSecret
    ? httpGoogleClient(config.google.clientId, config.google.clientSecret, config.google.redirectUri)
    : null,
};

/**
 * Deterministic Google event id for a booking. Google allows client-chosen ids
 * (base32hex: 0-9, a-v). A UUID's hex digits fit, so retrying a sync can never
 * create a duplicate event: it always targets the same id.
 */
export const eventIdFor = (bookingId: string) => `rb${bookingId.replace(/-/g, '')}`;
