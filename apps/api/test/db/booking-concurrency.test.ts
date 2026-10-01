/**
 * The core guarantee: no double-booking when requests arrive at the same moment.
 *
 * Each "request" below is its own connection and transaction, and a barrier
 * makes them all send their INSERT together.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { retryTransient } from '../../src/db/retry.js';
import {
  appPool, barrier, closePools, createOrgFixture, insertBooking, pgCode, range, uniqueDay, type OrgFixture,
} from '../helpers/db.js';

let org: OrgFixture;
beforeAll(async () => {
  org = await createOrgFixture(2);
});
afterAll(closePools);

async function begin(c: pg.PoolClient) {
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
}

describe('concurrent booking', () => {
  it('50 simultaneous requests for the same slot: exactly one wins, 49 get 23P01', async () => {
    const day = uniqueDay();
    const N = 50;
    const wait = barrier(N);
    const target = { orgId: org.orgId, userId: org.userId, roomId: org.roomIds[0]! };

    const results = await Promise.allSettled(
      Array.from({ length: N }, () => {
        let first = true;
        // Retried on deadlock, the same way the API does it.
        return retryTransient(async () => {
          const c = await appPool.connect();
          try {
            await begin(c);
            if (first) {
              first = false;
              await wait();
            }
            await insertBooking(c, target, range(day, 600, 660));
            await c.query('COMMIT');
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          } finally {
            c.release();
          }
        });
      }),
    );

    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.length - lost.length).toBe(1);
    expect(lost.map((r) => pgCode(r.reason))).toEqual(Array(N - 1).fill('23P01'));
  });

  it('a second writer waits for the first, then fails once the first commits', async () => {
    const day = uniqueDay();
    const target = { orgId: org.orgId, userId: org.userId, roomId: org.roomIds[1]! };
    const first = await appPool.connect();
    const second = await appPool.connect();
    try {
      await begin(first);
      await begin(second);
      await insertBooking(first, target, range(day, 600, 660)); // not committed yet

      let settled = false;
      const pending = insertBooking(second, target, range(day, 630, 690)).finally(() => (settled = true));
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // it waits for the first transaction to finish

      await first.query('COMMIT');
      expect(pgCode(await pending.catch((e) => e))).toBe('23P01');
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
  });
});

describe('for contrast: check first, then insert', () => {
  it('double-books when there is no constraint', async () => {
    // The same idea without the constraint, in a scratch table.
    const admin = new pg.Pool({
      host: config.db.host, port: config.db.port, database: config.db.database,
      user: config.db.superuser, password: config.db.superuserPassword, max: 12,
    });
    try {
      await admin.query('DROP TABLE IF EXISTS naive_bookings');
      await admin.query('CREATE TABLE naive_bookings (room_id int NOT NULL, during tstzrange NOT NULL)');
      const slot = range(uniqueDay(), 600, 660);
      const N = 10;
      const wait = barrier(N);

      await Promise.all(
        Array.from({ length: N }, async () => {
          const c = await admin.connect();
          try {
            await c.query('BEGIN');
            // Step 1: "is the slot free?" Every transaction sees the same empty table...
            const { rows } = await c.query('SELECT 1 FROM naive_bookings WHERE room_id = 1 AND during && $1::tstzrange', [slot]);
            await wait();
            // Step 2: ...so every one of them decides it is free and inserts.
            if (rows.length === 0) await c.query('INSERT INTO naive_bookings VALUES (1, $1)', [slot]);
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
