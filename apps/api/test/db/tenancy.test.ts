/**
 * Tenant isolation enforced by Postgres (RLS + composite foreign keys), tested
 * directly against the database as the API's low-privilege role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appPool, closePools, createOrgFixture, insertBooking, pgCode, range, uniqueDay, withOrg, type OrgFixture,
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

const TENANT_TABLES = ['organizations', 'users', 'buildings', 'floors', 'rooms', 'bookings', 'invitations', 'subscriptions'];

describe('row-level security', () => {
  it('sees zero rows in every tenant table when no org is set (fails closed)', async () => {
    for (const table of TENANT_TABLES) {
      const { rows } = await withOrg(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(rows[0].n, table).toBe(0);
    }
  });

  it("only sees the current org's rows", async () => {
    await withOrg(a.orgId, async (c) => {
      const orgs = await c.query('SELECT id FROM organizations');
      expect(orgs.rows.map((r) => r.id)).toEqual([a.orgId]);
      const rooms = await c.query('SELECT id FROM rooms');
      expect(rooms.rows.map((r) => r.id).sort()).toEqual([...a.roomIds].sort());
      const bookings = await c.query('SELECT id FROM bookings WHERE id = $1', [bBookingId]);
      expect(bookings.rowCount).toBe(0);
    });
  });

  it("cannot update or cancel another org's booking even by exact id", async () => {
    const res = await withOrg(a.orgId, (c) =>
      c.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bBookingId]),
    );
    expect(res.rowCount).toBe(0);
    const still = await withOrg(b.orgId, (c) => c.query('SELECT status FROM bookings WHERE id = $1', [bBookingId]));
    expect(still.rows[0].status).toBe('confirmed');
  });

  it("cannot insert a row tagged with another org's id (WITH CHECK)", async () => {
    const err = await withOrg(a.orgId, (c) =>
      c.query("INSERT INTO buildings (org_id, name, timezone) VALUES ($1, 'Sneaky', 'UTC')", [b.orgId]),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('42501'); // insufficient_privilege: new row violates row-level security policy
  });

  it("cannot move a row into another org by updating org_id", async () => {
    const err = await withOrg(a.orgId, (c) =>
      c.query('UPDATE buildings SET org_id = $1 WHERE id = $2', [b.orgId, a.buildingId]),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('composite foreign keys', () => {
  it("cannot book another org's room, even with its own org_id on the row", async () => {
    // RLS alone would allow this: the row's org_id is A's. FK checks bypass RLS, so
    // without the (room_id, org_id) FK this would succeed — and 23P01 conflicts would
    // then leak B's calendar to A.
    const err = await withOrg(a.orgId, (c) =>
      insertBooking(c, { orgId: a.orgId, userId: a.userId, roomId: b.roomIds[0]! }, range(uniqueDay(), 600, 660)),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('23503'); // foreign_key_violation
  });

  it("cannot create a room on another org's floor", async () => {
    const err = await withOrg(a.orgId, (c) =>
      c.query("INSERT INTO rooms (org_id, floor_id, name, capacity) VALUES ($1, $2, 'X', 4)", [a.orgId, b.floorId]),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('23503');
  });
});

describe('privileges of the app role', () => {
  it('has no access to refresh_tokens', async () => {
    const err = await withOrg(a.orgId, (c) => c.query('SELECT * FROM refresh_tokens')).catch((e) => e);
    expect(pgCode(err)).toBe('42501');
  });

  it('cannot hard-delete bookings (cancellation is a status change)', async () => {
    const err = await withOrg(b.orgId, (c) => c.query('DELETE FROM bookings WHERE id = $1', [bBookingId])).catch((e) => e);
    expect(pgCode(err)).toBe('42501');
  });

  it('does not leak app.org_id to the next transaction on a pooled connection', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [a.orgId]);
      await c.query('COMMIT');
      const { rows } = await c.query('SELECT count(*)::int AS n FROM rooms');
      expect(rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });
});
