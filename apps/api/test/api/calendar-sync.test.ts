import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, systemPool } from '../../src/db/index.js';
import { decryptSecret, encryptSecret } from '../../src/integrations/crypto.js';
import { eventIdFor, google, GoogleAuthRevokedError, type CalendarEvent, type GoogleClient } from '../../src/integrations/google-client.js';
import { runCalendarSyncBatch } from '../../src/integrations/calendar-worker.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

// ---------------------------------------------------------------------------
// A stub Google that records calls and can be told to fail.
// ---------------------------------------------------------------------------
type Call = { op: 'upsert' | 'delete'; eventId: string; event?: CalendarEvent };
const calls: Call[] = [];
let failNext: Error | null = null;
const stub: GoogleClient = {
  authUrl: (state) => `https://accounts.google.test/auth?state=${state}`,
  exchangeCode: async (code) => ({ refreshToken: `refresh-${code}`, email: `${code}@gmail.test`, scopes: 'calendar.events' }),
  accessToken: async () => {
    if (failNext instanceof GoogleAuthRevokedError) { const e = failNext; failNext = null; throw e; }
    return { token: 'access-token', expiresIn: 3600 };
  },
  upsertEvent: async (_t, eventId, event) => {
    if (failNext) { const e = failNext; failNext = null; throw e; }
    calls.push({ op: 'upsert', eventId, event });
  },
  deleteEvent: async (_t, eventId) => { calls.push({ op: 'delete', eventId }); },
  revoke: async () => {},
};

const callsFor = (bookingId: string) => calls.filter((c) => c.eventId === eventIdFor(bookingId));
const jobsFor = async (bookingId: string) =>
  (await systemPool.query('SELECT action, attempts, done_at, last_error, run_after FROM calendar_sync_outbox WHERE booking_id = $1 ORDER BY id', [bookingId])).rows;
const drain = async () => { while ((await runCalendarSyncBatch(50)) > 0) { /* keep going */ } };

let admin: TestSession;
let roomId: string;
let dayOffset = 5;
function slot(hh: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + dayOffset++);
  d.setUTCHours(hh);
  return { start: d.toISOString(), end: new Date(d.getTime() + 3_600_000).toISOString() };
}
const book = (s: TestSession, title = 'Sync me') =>
  api().post('/api/bookings').set('Authorization', bearer(s)).send({ roomId, title, ...slot(10) });

/** Runs the real OAuth connect → callback flow for a user against the stub. */
async function connectGoogle(s: TestSession, code = `code-${s.user.id.slice(0, 6)}`) {
  const start = await api().post('/api/integrations/google/connect').set('Authorization', bearer(s));
  const state = new URL(start.body.url).searchParams.get('state')!;
  const cookie = (start.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return api().get('/api/integrations/google/callback').query({ code, state }).set('Cookie', cookie);
}

beforeAll(async () => {
  google.client = stub;
  admin = await signupOrg();
  const b = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'HQ', address: '1 Main St', timezone: 'Asia/Kolkata' });
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(admin)).send({ name: '3rd Floor', level: 3 });
  roomId = (await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: 'Nilgiri', capacity: 8 })).body.id;
});
beforeEach(() => { calls.length = 0; failNext = null; });
afterAll(async () => {
  google.client = null;
  await closeDb();
});

describe('token encryption', () => {
  it('round-trips, uses a fresh IV each time, and rejects tampering', () => {
    const a = encryptSecret('1//refresh-token');
    const b = encryptSecret('1//refresh-token');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('1//refresh-token');
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('OAuth connection', () => {
  it('connect → callback stores an encrypted refresh token and reports status', async () => {
    const user = await addMember(admin);
    const res = await connectGoogle(user, 'alice');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/settings\?google=connected$/);

    const { rows } = await systemPool.query('SELECT google_email, refresh_token_enc FROM google_connections WHERE user_id = $1', [user.user.id]);
    expect(rows[0].google_email).toBe('alice@gmail.test');
    expect(rows[0].refresh_token_enc).not.toContain('refresh-alice');
    expect(decryptSecret(rows[0].refresh_token_enc)).toBe('refresh-alice');

    const status = await api().get('/api/integrations/google').set('Authorization', bearer(user));
    expect(status.body).toMatchObject({ configured: true, connected: true, email: 'alice@gmail.test' });
  });

  it('rejects a callback with a forged state or from a different browser', async () => {
    const user = await addMember(admin);
    expect((await api().get('/api/integrations/google/callback').query({ code: 'x', state: 'forged' })).status).toBe(400);

    const start = await api().post('/api/integrations/google/connect').set('Authorization', bearer(user));
    const state = new URL(start.body.url).searchParams.get('state')!;
    const noCookie = await api().get('/api/integrations/google/callback').query({ code: 'x', state });
    expect(noCookie.status).toBe(400);
    const wrongCookie = await api().get('/api/integrations/google/callback').query({ code: 'x', state }).set('Cookie', 'roomly_google_nonce=nope');
    expect(wrongCookie.status).toBe(400);
  });

  it('answers 503 when Google is not configured', async () => {
    google.client = null;
    try {
      const res = await api().post('/api/integrations/google/connect').set('Authorization', bearer(admin));
      expect(res.status).toBe(503);
    } finally {
      google.client = stub;
    }
  });

  it('backfills upcoming bookings made before connecting, and disconnect removes the connection', async () => {
    const user = await addMember(admin);
    const before = await book(user, 'Booked before connecting');
    expect(await jobsFor(before.body.id)).toHaveLength(0);
    await connectGoogle(user);
    expect((await jobsFor(before.body.id)).map((j) => j.action)).toEqual(['upsert']);

    await api().delete('/api/integrations/google').set('Authorization', bearer(user));
    const status = await api().get('/api/integrations/google').set('Authorization', bearer(user));
    expect(status.body.connected).toBe(false);
  });
});

describe('outbox trigger', () => {
  it('enqueues jobs for every change to a connected user’s booking, from any code path', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const b = await book(user);
    await api().patch(`/api/bookings/${b.body.id}`).set('Authorization', bearer(user)).send({ title: 'Renamed' });
    await api().patch(`/api/bookings/${b.body.id}`).set('Authorization', bearer(user)).send(slot(15));
    // Not a booking endpoint: deactivating the member cancels their future bookings.
    await api().patch(`/api/members/${user.user.id}`).set('Authorization', bearer(admin)).send({ isActive: false });
    expect((await jobsFor(b.body.id)).map((j) => j.action)).toEqual(['upsert', 'upsert', 'upsert', 'delete']);
  });

  it('does nothing for users who have not connected Google', async () => {
    const user = await addMember(admin);
    const b = await book(user);
    expect(await jobsFor(b.body.id)).toHaveLength(0);
  });

  it('a booking that rolls back (409) leaves no job behind', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const times = slot(9);
    await api().post('/api/bookings').set('Authorization', bearer(admin)).send({ roomId, title: 'First', ...times });
    const clash = await api().post('/api/bookings').set('Authorization', bearer(user)).send({ roomId, title: 'Clash', ...times });
    expect(clash.status).toBe(409);
    const { rows } = await systemPool.query(
      "SELECT count(*)::int AS n FROM calendar_sync_outbox o JOIN bookings b ON b.id = o.booking_id WHERE b.title = 'Clash'",
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('sync worker', () => {
  it('creates the Google event in the building time zone, then deletes it on cancel', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const b = await book(user, 'Design review');
    await drain();
    expect(callsFor(b.body.id)).toEqual([{
      op: 'upsert',
      eventId: eventIdFor(b.body.id),
      event: {
        summary: 'Design review',
        location: 'Nilgiri (3rd Floor), HQ, 1 Main St',
        description: 'Meeting room booked by Mo Member via Roomly.',
        start: { dateTime: b.body.start, timeZone: 'Asia/Kolkata' },
        end: { dateTime: b.body.end, timeZone: 'Asia/Kolkata' },
      },
    }]);
    expect((await jobsFor(b.body.id))[0].done_at).not.toBeNull();

    await api().delete(`/api/bookings/${b.body.id}`).set('Authorization', bearer(user));
    await drain();
    expect(callsFor(b.body.id).map((c) => c.op)).toEqual(['upsert', 'delete']);
  });

  it('retries with backoff when Google fails, then succeeds', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const b = await book(user);
    failNext = new Error('Google 503');
    await drain();
    let [job] = await jobsFor(b.body.id);
    expect(job).toMatchObject({ attempts: 1, done_at: null, last_error: 'Google 503' });
    expect(job.run_after.getTime()).toBeGreaterThan(Date.now());

    await systemPool.query('UPDATE calendar_sync_outbox SET run_after = now() WHERE booking_id = $1', [b.body.id]);
    await drain();
    [job] = await jobsFor(b.body.id);
    expect(job.done_at).not.toBeNull();
    expect(callsFor(b.body.id)).toHaveLength(1);
  });

  it('drops the connection when the user has revoked access on Google', async () => {
    const user = await addMember(admin);
    await connectGoogle(user, `revoker-${Date.now()}`);
    const b = await book(user);
    failNext = new GoogleAuthRevokedError('revoked');
    // Force a fresh access-token fetch for this user by using a new user (cache is per user).
    await drain();
    const { rows } = await systemPool.query('SELECT 1 FROM google_connections WHERE user_id = $1', [user.user.id]);
    expect(rows).toHaveLength(0);
    expect((await jobsFor(b.body.id))[0].last_error).toBe('revoked');
  });

  it('applies a booking’s changes in order: create then cancel ends with the event deleted', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const b = await book(user);
    await api().delete(`/api/bookings/${b.body.id}`).set('Authorization', bearer(user));
    // Both jobs are due, but only the first may be claimed while it's pending.
    await drain();
    const ops = callsFor(b.body.id).map((c) => c.op);
    expect(ops.at(-1)).toBe('delete');
    expect(ops).not.toContain('upsert'); // the first job already saw the cancelled state
  });

  it('two workers draining concurrently process each job exactly once (SKIP LOCKED)', async () => {
    const user = await addMember(admin);
    await connectGoogle(user);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await book(user, `Bulk ${i}`)).body.id);
    await Promise.all([drain(), drain(), drain()]);
    for (const id of ids) expect(callsFor(id)).toHaveLength(1);
  });
});
