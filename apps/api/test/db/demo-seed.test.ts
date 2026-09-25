/**
 * The public demo is reset nightly. resetDemo must restore the demo companies
 * exactly, and must never touch organizations that real visitors created.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { organizationCount, resetDemo } from '../../../../scripts/seed.js';
import { closePools, systemPool } from '../helpers/db.js';
import { signupOrg } from '../helpers/api.js';
import { closeDb } from '../../src/db/index.js';

afterAll(async () => {
  await closePools();
  await closeDb();
});

const q = (sql: string, params: unknown[] = []) => systemPool.query(sql, params).then((r) => r.rows);

describe('demo reset', () => {
  it('restores the demo companies and leaves visitor organizations alone', async () => {
    await resetDemo(config.db.database);
    const visitor = await signupOrg('Visitor Co');

    // A visitor messes with the demo: deactivates an employee and adds a booking.
    const [rahul] = await q("SELECT id, org_id FROM users WHERE email = 'rahul@acme.test'");
    await q('UPDATE users SET is_active = false WHERE id = $1', [rahul.id]);
    const [room] = await q("SELECT r.id FROM rooms r JOIN organizations o ON o.id = r.org_id WHERE o.slug = 'acme' AND r.name = 'Hampi'");
    await q(
      `INSERT INTO bookings (org_id, room_id, user_id, title, during)
       VALUES ($1, $2, $3, 'Visitor scribble', tstzrange(date_trunc('minute', now()) + interval '3 days', date_trunc('minute', now()) + interval '3 days 1 hour', '[)'))`,
      [rahul.org_id, room.id, rahul.id],
    );

    await resetDemo(config.db.database);

    const [again] = await q("SELECT is_active FROM users WHERE email = 'rahul@acme.test'");
    expect(again.is_active).toBe(true);
    expect(await q("SELECT 1 FROM bookings WHERE title = 'Visitor scribble'")).toHaveLength(0);
    expect(await q("SELECT slug FROM organizations WHERE slug IN ('acme', 'northwind') ORDER BY slug")).toEqual([
      { slug: 'acme' }, { slug: 'northwind' },
    ]);
    const [seeded] = await q(
      "SELECT count(*)::int AS n FROM bookings b JOIN organizations o ON o.id = b.org_id WHERE o.slug IN ('acme', 'northwind')",
    );
    expect(seeded.n).toBe(7);
    expect(await q('SELECT 1 FROM organizations WHERE id = $1', [visitor.org.id])).toHaveLength(1);
    expect(await organizationCount(config.db.database)).toBeGreaterThan(2);
  });
});
