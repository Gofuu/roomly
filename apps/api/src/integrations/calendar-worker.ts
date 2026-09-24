/**
 * Drains calendar_sync_outbox (see migration 005).
 *
 * Claiming uses a lease: one short transaction marks up to N due jobs as
 * "leased until now + 2 min" and commits. The Google calls then happen outside
 * any transaction, and a final update marks each job done or schedules a retry.
 * If the worker dies mid-job, the lease expires and another worker takes it.
 *
 *  - FOR UPDATE SKIP LOCKED lets several workers claim at once without taking
 *    the same job or blocking each other.
 *  - A job is only claimable when no earlier job for the same booking is still
 *    pending, so a booking's changes reach Google in order.
 *  - Each job syncs the booking's CURRENT state (upsert if confirmed, delete if
 *    cancelled), and event ids are deterministic, so re-running a job is harmless.
 */
import { sql } from 'kysely';
import { withSystem } from '../db/index.js';
import { bus } from '../realtime/bus.js';
import { decryptSecret } from './crypto.js';
import { GoogleAuthRevokedError, eventIdFor, google, type CalendarEvent } from './google-client.js';

const LEASE = '2 minutes';
const MAX_ATTEMPTS = 6;

/** Access tokens cached per user until shortly before they expire. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

interface Job {
  id: string;
  booking_id: string;
  user_id: string;
  attempts: number;
}

async function claim(limit: number): Promise<Job[]> {
  const { rows } = await withSystem((tx) =>
    sql<Job>`
      UPDATE calendar_sync_outbox o
         SET run_after = now() + ${LEASE}::interval, attempts = o.attempts + 1
       WHERE o.id IN (
         SELECT c.id FROM calendar_sync_outbox c
          WHERE c.done_at IS NULL AND c.run_after <= now()
            AND NOT EXISTS (
              SELECT 1 FROM calendar_sync_outbox earlier
               WHERE earlier.booking_id = c.booking_id AND earlier.done_at IS NULL AND earlier.id < c.id)
          ORDER BY c.id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.booking_id, o.user_id, o.attempts`.execute(tx),
  );
  return rows;
}

async function finish(jobId: string, error?: string) {
  await withSystem((tx) =>
    tx.updateTable('calendar_sync_outbox').set({ done_at: sql`now()`, last_error: error ?? null })
      .where('id', '=', jobId).execute(),
  );
}

async function retryLater(job: Job, error: string) {
  if (job.attempts >= MAX_ATTEMPTS) return finish(job.id, `gave up: ${error}`);
  const backoffSeconds = 10 * 2 ** (job.attempts - 1); // 10s, 20s, 40s, 80s, 160s
  await withSystem((tx) =>
    tx.updateTable('calendar_sync_outbox')
      .set({ run_after: sql`now() + make_interval(secs => ${backoffSeconds})`, last_error: error })
      .where('id', '=', job.id).execute(),
  );
}

async function accessTokenFor(userId: string, refreshTokenEnc: string): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const { token, expiresIn } = await google.client!.accessToken(decryptSecret(refreshTokenEnc));
  tokenCache.set(userId, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function syncJob(job: Job): Promise<void> {
  const data = await withSystem(async (tx) => {
    const connection = await tx.selectFrom('google_connections').select(['refresh_token_enc'])
      .where('user_id', '=', job.user_id).executeTakeFirst();
    const booking = await tx.selectFrom('bookings as b')
      .innerJoin('rooms as r', 'r.id', 'b.room_id')
      .innerJoin('floors as f', 'f.id', 'r.floor_id')
      .innerJoin('buildings as bl', 'bl.id', 'f.building_id')
      .innerJoin('users as u', 'u.id', 'b.user_id')
      .select([
        'b.title', 'b.status', 'r.name as room', 'f.name as floor', 'bl.name as building', 'bl.address', 'bl.timezone',
        'u.name as organizer',
        sql<Date>`lower(b.during)`.as('starts_at'),
        sql<Date>`upper(b.during)`.as('ends_at'),
      ])
      .where('b.id', '=', job.booking_id)
      .executeTakeFirst();
    return { connection, booking };
  });

  if (!data.connection) return finish(job.id, 'Google Calendar not connected');
  if (!google.client) return retryLater(job, 'Google client not configured');

  try {
    const token = await accessTokenFor(job.user_id, data.connection.refresh_token_enc);
    const eventId = eventIdFor(job.booking_id);
    const b = data.booking;
    if (!b || b.status === 'cancelled') {
      await google.client.deleteEvent(token, eventId);
    } else {
      const event: CalendarEvent = {
        summary: b.title,
        location: [`${b.room} (${b.floor})`, b.building, b.address].filter(Boolean).join(', '),
        description: `Meeting room booked by ${b.organizer} via Roomly.`,
        start: { dateTime: b.starts_at.toISOString(), timeZone: b.timezone },
        end: { dateTime: b.ends_at.toISOString(), timeZone: b.timezone },
      };
      await google.client.upsertEvent(token, eventId, event);
    }
    await finish(job.id);
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) {
      // The user revoked access on Google's side: forget the connection. Their
      // later jobs will finish with "not connected".
      tokenCache.delete(job.user_id);
      await withSystem((tx) => tx.deleteFrom('google_connections').where('user_id', '=', job.user_id).execute());
      return finish(job.id, err.message);
    }
    await retryLater(job, (err as Error).message);
  }
}

/** Claims and processes one batch. Returns how many jobs it handled. */
export async function runCalendarSyncBatch(limit = 10): Promise<number> {
  const jobs = await claim(limit);
  await Promise.all(jobs.map(syncJob));
  return jobs.length;
}

/**
 * Polls every `intervalMs`, and also wakes as soon as a booking changes so
 * syncs usually land within a second. Returns a stop function.
 */
export function startCalendarWorker(intervalMs = 5000): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && (await runCalendarSyncBatch()) > 0) { /* drain */ }
    } catch (err) {
      console.error('[calendar-sync]', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  const wake = () => setTimeout(tick, 200);
  bus.on('booking', wake);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    bus.off('booking', wake);
  };
}
