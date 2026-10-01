import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, createOrgFixture, insertBooking, pgCode, range, uniqueDay, withOrg, type OrgFixture } from '../helpers/db.js';

let org: OrgFixture;
const booking = (roomIndex = 0) => ({ orgId: org.orgId, userId: org.userId, roomId: org.roomIds[roomIndex]! });
const cancel = (id: string) =>
  withOrg(org.orgId, (c) => c.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [id]));

beforeAll(async () => {
  org = await createOrgFixture(2);
});
afterAll(closePools);

describe('bookings_no_overlap exclusion constraint', () => {
  it('rejects an overlapping booking for the same room with 23P01', async () => {
    const day = uniqueDay();
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 600, 660))); // 10:00 to 11:00
    const err = await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 630, 690))).catch((e) => e);
    expect(pgCode(err)).toBe('23P01');
  });

  it('allows back-to-back bookings because ranges are half-open [start, end)', async () => {
    const day = uniqueDay();
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 600, 660))); // 10 to 11
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 660, 720))); // 11 to 12
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 540, 600))); // 9 to 10
  });

  it('allows the same time slot in a different room', async () => {
    const day = uniqueDay();
    await withOrg(org.orgId, (c) => insertBooking(c, booking(0), range(day, 600, 660)));
    await withOrg(org.orgId, (c) => insertBooking(c, booking(1), range(day, 600, 660)));
  });

  it('frees the slot when a booking is cancelled', async () => {
    const day = uniqueDay();
    const { rows } = await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 600, 660)));
    await cancel(rows[0].id);
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 600, 660)));
  });

  it('checks a reschedule against the constraint too', async () => {
    const day = uniqueDay();
    await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 600, 660)));
    const { rows } = await withOrg(org.orgId, (c) => insertBooking(c, booking(), range(day, 720, 780)));
    const err = await withOrg(org.orgId, (c) =>
      c.query('UPDATE bookings SET during = $1 WHERE id = $2', [range(day, 630, 690), rows[0].id]),
    ).catch((e) => e);
    expect(pgCode(err)).toBe('23P01');
  });
});

describe('bookings_valid_range check', () => {
  it('rejects empty, open-ended, inclusive-end and longer-than-12-hour ranges', async () => {
    const day = uniqueDay();
    const t = (m: number) => new Date(day.getTime() + m * 60_000).toISOString();
    const rejects = async (during: string) =>
      pgCode(await withOrg(org.orgId, (c) => insertBooking(c, booking(), during)).catch((e) => e));

    expect(await rejects(`[${t(600)},${t(600)})`)).toBe('23514'); // empty
    expect(await rejects(`[${t(600)},)`)).toBe('23514'); // no end
    expect(await rejects(`[${t(600)},${t(660)}]`)).toBe('23514'); // inclusive end
    expect(await rejects(`[${t(0)},${t(13 * 60)})`)).toBe('23514'); // 13 hours
  });
});
