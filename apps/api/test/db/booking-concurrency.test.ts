/**
 * The core guarantee: no double-booking under concurrent requests.
 *
 * Each "request" below is a separate connection with its own transaction, and a
 * barrier makes them all issue their INSERT at the same moment. Requests are
 * wrapped in retryTransient exactly as the API wraps them, although with the
 * per-room lock from migration 003 no retries should ever be needed.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { retryTransient } from '../../src/db/retry.js';
import {
  appPool, barrier, closePools, createOrgFixture, insertBooking, pgCode, range, uniqueDay, withOrg, type OrgFixture,
} from '../helpers/db.js';
import { env } from '../../../../scripts/lib/env.js';

let org: OrgFixture;
beforeAll(async () => {
  org = await createOrgFixture(3);
});
afterAll(closePools);

/**
 * One simulated request: a transaction scoped to the org that waits at the
 * barrier (first attempt only) before running `work`, retried on deadlock.
 */
function concurrentRequest<T>(wait: () => Promise<void>, work: (c: pg.PoolClient) => Promise<T>, stats: { retries: number }) {
  return retryTransient(async (attempt) => {
    if (attempt > 1) stats.retries++;
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      if (attempt === 1) await wait();
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  });
}

function countOverlaps(day: Date) {
  return withOrg(org.orgId, (c) =>
    c.query(
      `SELECT count(*)::int AS n
         FROM bookings a JOIN bookings b
           ON a.room_id = b.room_id AND a.id < b.id AND a.during && b.during
        WHERE a.status = 'confirmed' AND b.status = 'confirmed'
          AND a.during && $1::tstzrange`,
      [range(day, 0, 1440)],
    ),
  ).then((r) => r.rows[0].n as number);
}

describe('concurrent booking', () => {
  it('50 simultaneous requests for the same slot: exactly one wins, 49 get 23P01', async () => {
    const day = uniqueDay();
    const N = 50;
    const wait = barrier(N);
    const stats = { retries: 0 };
    const target = { orgId: org.orgId, userId: org.userId, roomId: org.roomIds[0]! };

    const results = await Promise.allSettled(
      Array.from({ length: N }, () => concurrentRequest(wait, (c) => insertBooking(c, target, range(day, 600, 660)), stats)),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => pgCode(r.reason))).toEqual(Array(N - 1).fill('23P01'));
  });

  it('60 simultaneous random bookings across 3 rooms: no overlaps, and every request gets a definite answer', async () => {
    const day = uniqueDay();
    const N = 60; // must stay below the pool size, or the barrier can never fill
    const wait = barrier(N);
    const stats = { retries: 0 };
    // Random 15–120 minute meetings between 08:00 and 18:00 on 5-minute boundaries.
    const requests = Array.from({ length: N }, () => {
      const start = 480 + 5 * Math.floor(Math.random() * 110);
      const length = 15 * (1 + Math.floor(Math.random() * 8));
      const roomId = org.roomIds[Math.floor(Math.random() * 3)]!;
      return { roomId, during: range(day, start, start + length) };
    });

    const results = await Promise.allSettled(
      requests.map((r) =>
        concurrentRequest(
          wait,
          (c) => insertBooking(c, { orgId: org.orgId, userId: org.userId, roomId: r.roomId }, r.during),
          stats,
        ),
      ),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // After retries, the only failure is "slot taken" — never a deadlock surfacing to the caller.
    expect(rejected.every((r) => pgCode(r.reason) === '23P01')).toBe(true);
    expect(await countOverlaps(day)).toBe(0);
    expect(results.length - rejected.length).toBeGreaterThan(0);
    // Migration 003 serializes writers per room, so simultaneous overlapping inserts
    // queue instead of deadlocking. Without it this test sees 40P01 retries.
    expect(stats.retries).toBe(0);
  });

  it('the second writer waits for the first: fails if the first commits…', async () => {
    const day = uniqueDay();
    const target = { orgId: org.orgId, userId: org.userId, roomId: org.roomIds[1]! };
    const first = await appPool.connect();
    const second = await appPool.connect();
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      }
      await insertBooking(first, target, range(day, 600, 660)); // not committed yet

      let settled = false;
      const pending = insertBooking(second, target, range(day, 630, 690)).finally(() => (settled = true));
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // queued behind the first transaction's per-room lock

      await first.query('COMMIT');
      const err = await pending.catch((e) => e);
      expect(pgCode(err)).toBe('23P01');
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
  });

  it('…and succeeds if the first rolls back', async () => {
    const day = uniqueDay();
    const target = { orgId: org.orgId, userId: org.userId, roomId: org.roomIds[1]! };
    const first = await appPool.connect();
    const second = await appPool.connect();
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      }
      await insertBooking(first, target, range(day, 600, 660));
      const pending = insertBooking(second, target, range(day, 630, 690));
      await new Promise((r) => setTimeout(r, 300));
      await first.query('ROLLBACK');
      await expect(pending).resolves.toBeDefined();
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
  });
});

describe('contrast: the naive check-then-insert pattern', () => {
  it('double-books under concurrency when there is no constraint', async () => {
    // A copy of the idea without the constraint, built by the superuser in a scratch table.
    const admin = new pg.Pool({
      host: config.db.host, port: config.db.port, database: config.db.database,
      user: env.superuser, password: env.superuserPassword, max: 12,
    });
    try {
      await admin.query('DROP TABLE IF EXISTS naive_bookings');
      await admin.query('CREATE TABLE naive_bookings (room_id int NOT NULL, during tstzrange NOT NULL)');
      const day = uniqueDay();
      const N = 10;
      const wait = barrier(N);

      await Promise.all(
        Array.from({ length: N }, async () => {
          const c = await admin.connect();
          try {
            await c.query('BEGIN');
            // Step 1: "is the slot free?" — every transaction sees the same empty snapshot…
            const { rows } = await c.query(
              'SELECT 1 FROM naive_bookings WHERE room_id = 1 AND during && $1::tstzrange',
              [range(day, 600, 660)],
            );
            await wait();
            // Step 2: …so every one of them decides it's free and inserts.
            if (rows.length === 0) {
              await c.query('INSERT INTO naive_bookings VALUES (1, $1)', [range(day, 600, 660)]);
            }
            await c.query('COMMIT');
          } finally {
            c.release();
          }
        }),
      );

      const { rows } = await admin.query('SELECT count(*)::int AS n FROM naive_bookings');
      expect(rows[0].n).toBe(N); // every request "succeeded": the room is booked 10 times
      await admin.query('DROP TABLE naive_bookings');
    } finally {
      await admin.end();
    }
  });
});
