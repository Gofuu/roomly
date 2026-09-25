/**
 * Demo data: two companies in different time zones, so time zone handling is
 * visible in the UI. Every seeded user's password is DEMO_PASSWORD.
 * Runs as the superuser/owner (bypasses RLS).
 *
 *   seed(db)       — insert the demo companies (fresh database)
 *   resetDemo(db)  — delete and re-create ONLY the demo companies, leaving any
 *                    organizations real visitors signed up untouched. Run nightly
 *                    on the public demo so visitors always find it in a clean state.
 */
import type pg from 'pg';
import { superClient } from './lib/migrations.js';
import { hashPassword } from '../apps/api/src/auth/password.js';

export const DEMO_PASSWORD = 'Password123!';

type Seed = {
  org: { name: string; slug: string; plan: string };
  users: { name: string; email: string; role: 'admin' | 'employee' }[];
  building: { name: string; address: string; timezone: string };
  floors: { name: string; level: number; rooms: { name: string; capacity: number; amenities: string[] }[] }[];
  // [day offset from today, local start "HH:MM", minutes, room name, user email, title]
  bookings: [number, string, number, string, string, string][];
};

const SEEDS: Seed[] = [
  {
    org: { name: 'Acme Analytics', slug: 'acme', plan: 'pro' },
    users: [
      { name: 'Priya Sharma', email: 'admin@acme.test', role: 'admin' },
      { name: 'Rahul Verma', email: 'rahul@acme.test', role: 'employee' },
      { name: 'Ananya Iyer', email: 'ananya@acme.test', role: 'employee' },
    ],
    building: { name: 'Bengaluru HQ', address: 'Outer Ring Road, Bellandur, Bengaluru', timezone: 'Asia/Kolkata' },
    floors: [
      {
        name: '3rd Floor', level: 3, rooms: [
          { name: 'Nilgiri', capacity: 8, amenities: ['tv', 'whiteboard', 'video'] },
          { name: 'Kaveri', capacity: 4, amenities: ['tv'] },
          { name: 'Focus Pod 1', capacity: 1, amenities: [] },
        ],
      },
      {
        name: '4th Floor', level: 4, rooms: [
          { name: 'Western Ghats', capacity: 16, amenities: ['projector', 'whiteboard', 'video'] },
          { name: 'Hampi', capacity: 6, amenities: ['whiteboard'] },
        ],
      },
    ],
    bookings: [
      [0, '10:00', 60, 'Nilgiri', 'rahul@acme.test', 'Sprint planning'],
      [0, '14:30', 30, 'Kaveri', 'ananya@acme.test', '1:1 with Priya'],
      [1, '09:30', 90, 'Western Ghats', 'admin@acme.test', 'Quarterly business review'],
      [1, '11:00', 60, 'Nilgiri', 'ananya@acme.test', 'Design critique'],
      [2, '16:00', 45, 'Hampi', 'rahul@acme.test', 'Customer call: Globex'],
    ],
  },
  {
    org: { name: 'Northwind Labs', slug: 'northwind', plan: 'free' },
    users: [
      { name: 'Oliver Bennett', email: 'admin@northwind.test', role: 'admin' },
      { name: 'Emma Clarke', email: 'emma@northwind.test', role: 'employee' },
    ],
    building: { name: 'London Office', address: '1 Finsbury Avenue, London', timezone: 'Europe/London' },
    floors: [
      {
        name: '2nd Floor', level: 2, rooms: [
          { name: 'Thames', capacity: 10, amenities: ['tv', 'video'] },
          { name: 'Soho', capacity: 6, amenities: ['whiteboard'] },
          { name: 'Camden', capacity: 4, amenities: [] },
        ],
      },
    ],
    bookings: [
      [0, '09:00', 30, 'Thames', 'emma@northwind.test', 'Stand-up'],
      [1, '13:00', 60, 'Soho', 'admin@northwind.test', 'Hiring panel'],
    ],
  },
];

export const DEMO_SLUGS = SEEDS.map((s) => s.org.slug);

async function insertSeeds(c: pg.Client, passwordHash: string) {
  for (const s of SEEDS) {
    const { rows: [org] } = await c.query(
      'INSERT INTO organizations (name, slug, plan_id) VALUES ($1, $2, $3) RETURNING id',
      [s.org.name, s.org.slug, s.org.plan],
    );
    const userIds = new Map<string, string>();
    for (const u of s.users) {
      const { rows: [row] } = await c.query(
        'INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [org.id, u.email, u.name, passwordHash, u.role],
      );
      userIds.set(u.email, row.id);
    }
    const { rows: [building] } = await c.query(
      'INSERT INTO buildings (org_id, name, address, timezone) VALUES ($1, $2, $3, $4) RETURNING id',
      [org.id, s.building.name, s.building.address, s.building.timezone],
    );
    const roomIds = new Map<string, string>();
    for (const f of s.floors) {
      const { rows: [floor] } = await c.query(
        'INSERT INTO floors (org_id, building_id, name, level) VALUES ($1, $2, $3, $4) RETURNING id',
        [org.id, building.id, f.name, f.level],
      );
      for (const r of f.rooms) {
        const { rows: [room] } = await c.query(
          'INSERT INTO rooms (org_id, floor_id, name, capacity, amenities) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [org.id, floor.id, r.name, r.capacity, r.amenities],
        );
        roomIds.set(r.name, room.id);
      }
    }
    for (const [day, start, minutes, roomName, email, title] of s.bookings) {
      // Wall-clock time in the building's time zone → an absolute instant.
      await c.query(
        `INSERT INTO bookings (org_id, room_id, user_id, title, during)
         SELECT $1, $2, $3, $4, tstzrange(t, t + make_interval(mins => $5), '[)')
         FROM (SELECT ((now() AT TIME ZONE $6)::date + $7::int + $8::time) AT TIME ZONE $6 AS t) s`,
        [org.id, roomIds.get(roomName), userIds.get(email), title, minutes, s.building.timezone, day, start],
      );
    }
  }
}

async function inTransaction(database: string, fn: (c: pg.Client) => Promise<void>) {
  const c = superClient(database);
  await c.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}

export async function seed(database: string) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await inTransaction(database, (c) => insertSeeds(c, passwordHash));
}

export async function resetDemo(database: string) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await inTransaction(database, async (c) => {
    // Bookings reference rooms/users with RESTRICT, so remove them before the org cascade.
    await c.query(
      'DELETE FROM bookings WHERE org_id IN (SELECT id FROM organizations WHERE slug = ANY($1))',
      [DEMO_SLUGS],
    );
    await c.query('DELETE FROM organizations WHERE slug = ANY($1)', [DEMO_SLUGS]);
    await insertSeeds(c, passwordHash);
  });
}

export async function organizationCount(database: string): Promise<number> {
  const c = superClient(database);
  await c.connect();
  try {
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations')).rows[0]!.n;
  } finally {
    await c.end();
  }
}
