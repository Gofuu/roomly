/**
 * Company isolation enforced by Postgres (row-level security + composite foreign
 * keys), tested straight against the database as the role the API uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePools, createOrgFixture, insertBooking, pgCode, range, uniqueDay, withOrg, type OrgFixture,
} from '../helpers/db.js';

let a: OrgFixture;
let b: OrgFixture;
let bBookingId: string;

beforeAll(async () => {
  a = await createOrgFixture(2);
  b = await createOrgFixture(2);
  const { rows } = await withOrg(b.orgId, (c) =>
    insertBooking(c, { orgId: b.orgId, userId: b.userId, roomId: b.roomIds[0]! }, range(uniqueDay(), 600, 660)),
  );
  bBookingId = rows[0].id;
});
afterAll(closePools);

describe('row-level security', () => {
  it('shows no rows at all when no company is set', async () => {
    for (const table of ['buildings', 'floors', 'rooms', 'bookings']) {
      const { rows } = await withOrg(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(rows[0].n, table).toBe(0);
    }
  });

  it("only shows the current company's rows", async () => {
    await withOrg(a.orgId, async (c) => {
      const rooms = await c.query('SELECT id FROM rooms');
      expect(rooms.rows.map((r) => r.id).sort()).toEqual([...a.roomIds].sort());
      const bookings = await c.query('SELECT id FROM bookings WHERE id = $1', [bBookingId]);
      expect(bookings.rowCount).toBe(0);
    });
  });

  it("cannot change another company's booking, even with its exact id", async () => {
    const res = await withOrg(a.orgId, (c) =>
      c.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bBookingId]),
    );
    expect(res.rowCount).toBe(0);
    const still = await withOrg(b.orgId, (c) => c.query('SELECT status FROM bookings WHERE id = $1', [bBookingId]));
    expect(still.rows[0].status).toBe('confirmed');
  });

  it("cannot insert a row labelled with another company's id", async () => {
    const err = await withOrg(a.orgId, (c) =>
      c.query("INSERT INTO buildings (org_id, name, timezone) VALUES ($1, 'Sneaky', 'UTC')", [b.orgId]),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('42501'); // new row violates row-level security policy
  });
});

describe('composite foreign keys', () => {
  it("cannot book another company's room, even with its own org_id on the row", async () => {
    // Row-level security alone would allow this, because the row's org_id is A's.
    // The (room_id, org_id) foreign key is what stops it.
    const err = await withOrg(a.orgId, (c) =>
      insertBooking(c, { orgId: a.orgId, userId: a.userId, roomId: b.roomIds[0]! }, range(uniqueDay(), 600, 660)),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('23503'); // foreign_key_violation
  });
});
