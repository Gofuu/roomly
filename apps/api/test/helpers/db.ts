/**
 * Raw-SQL helpers for database-level tests. These deliberately bypass the API so
 * the tests prove what the *database* guarantees on its own.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';

const base = { host: config.db.host, port: config.db.port, database: config.db.database };

/** Connects as the low-privilege API role — subject to RLS. */
export const appPool = new pg.Pool({ ...base, user: config.db.appUser, password: config.db.appPassword, max: 70 });
/** Connects as the privileged cross-tenant role — used here to create fixtures. */
export const systemPool = new pg.Pool({ ...base, user: config.db.systemUser, password: config.db.systemPassword, max: 5 });

export async function closePools() {
  await Promise.all([appPool.end(), systemPool.end()]);
}

/** Runs fn in a transaction scoped to orgId, exactly as the API will. */
export async function withOrg<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if (orgId) await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export type OrgFixture = {
  orgId: string;
  userId: string;
  buildingId: string;
  floorId: string;
  roomIds: string[];
};

/** Creates an org with one admin, one building/floor and `rooms` rooms. */
export async function createOrgFixture(rooms = 2): Promise<OrgFixture> {
  const tag = randomUUID().slice(0, 8);
  const q = (sql: string, params: unknown[]) => systemPool.query(sql, params).then((r) => r.rows[0]);
  const org = await q('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [`Org ${tag}`, `org-${tag}`]);
  const user = await q(
    "INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1, $2, 'Test Admin', 'x', 'admin') RETURNING id",
    [org.id, `admin-${tag}@example.test`],
  );
  const building = await q(
    "INSERT INTO buildings (org_id, name, timezone) VALUES ($1, 'HQ', 'Asia/Kolkata') RETURNING id",
    [org.id],
  );
  const floor = await q(
    "INSERT INTO floors (org_id, building_id, name, level) VALUES ($1, $2, 'Ground', 0) RETURNING id",
    [org.id, building.id],
  );
  const roomIds: string[] = [];
  for (let i = 0; i < rooms; i++) {
    const room = await q(
      'INSERT INTO rooms (org_id, floor_id, name, capacity) VALUES ($1, $2, $3, 6) RETURNING id',
      [org.id, floor.id, `Room ${i + 1}`],
    );
    roomIds.push(room.id);
  }
  return { orgId: org.id, userId: user.id, buildingId: building.id, floorId: floor.id, roomIds };
}

/** A far-future day per test run, so tests never collide with each other's bookings. */
let dayCounter = 0;
export function uniqueDay(): Date {
  const d = new Date(Date.UTC(2030, 0, 1));
  d.setUTCDate(d.getUTCDate() + dayCounter++);
  return d;
}

/** "[day+startMin, day+endMin)" as a tstzrange literal. */
export function range(day: Date, startMin: number, endMin: number): string {
  const at = (m: number) => new Date(day.getTime() + m * 60_000).toISOString();
  return `[${at(startMin)},${at(endMin)})`;
}

export function insertBooking(c: pg.ClientBase, f: { orgId: string; userId: string; roomId: string }, during: string) {
  return c.query(
    "INSERT INTO bookings (org_id, room_id, user_id, title, during) VALUES ($1, $2, $3, 'Test', $4) RETURNING id",
    [f.orgId, f.roomId, f.userId, during],
  );
}

/** Resolves once `n` callers are waiting, so concurrent work starts together. */
export function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return () => {
    if (++arrived === n) release();
    return open;
  };
}

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}
