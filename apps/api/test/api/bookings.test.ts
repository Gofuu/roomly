import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/db/index.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

afterAll(closeDb);

/** A UTC time `days` days from today at hh:mm, as ISO. */
function slot(days: number, hh: number, mm = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm);
  return d.toISOString();
}
// Every test books on its own day, so they never get in each other's way.
let dayCursor = 2;
const nextDay = () => dayCursor++;

let admin: TestSession;
let employee: TestSession;
let other: TestSession;
let buildingId: string;
let rooms: string[];

const book = (s: TestSession, roomId: string, start: string, end: string, title = 'Sync') =>
  api().post('/api/bookings').set('Authorization', bearer(s)).send({ roomId, title, start, end });

beforeAll(async () => {
  admin = await signupOrg();
  employee = await addMember(admin);
  other = await addMember(admin);
  const auth = bearer(admin);
  const b = await api().post('/api/buildings').set('Authorization', auth).send({ name: 'HQ', timezone: 'Asia/Kolkata' });
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', auth).send({ name: 'G', level: 0 });
  buildingId = b.body.id;
  rooms = [];
  for (const name of ['Small', 'Large']) {
    rooms.push((await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', auth).send({ name, capacity: 6 })).body.id);
  }
});

describe('creating bookings', () => {
  it('books a room, and answers 409 with the clashing booking when the time is taken', async () => {
    const d = nextDay();
    const ok = await book(employee, rooms[0]!, slot(d, 10), slot(d, 11), 'Planning');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: 'Planning', isMine: true, start: slot(d, 10), end: slot(d, 11) });

    const clash = await book(other, rooms[0]!, slot(d, 10, 30), slot(d, 11, 30));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('BOOKING_CONFLICT');
    expect(clash.body.error.details.conflicts).toEqual([
      { start: slot(d, 10), end: slot(d, 11), title: 'Planning', organizerName: 'Mo Member' },
    ]);

    expect((await book(other, rooms[0]!, slot(d, 11), slot(d, 12))).status).toBe(201); // straight after
    expect((await book(other, rooms[1]!, slot(d, 10), slot(d, 11))).status).toBe(201); // other room
  });

  it('20 requests for one slot at the same moment: one 201, nineteen 409s', async () => {
    const d = nextDay();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => book(i % 2 ? employee : other, rooms[1]!, slot(d, 9), slot(d, 10))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, ...Array(19).fill(409)]);
  });

  it('rejects times that make no sense', async () => {
    const d = nextDay();
    const r = rooms[0]!;
    expect((await book(employee, r, slot(-1, 10), slot(-1, 11))).status).toBe(400); // in the past
    expect((await book(employee, r, slot(d, 11), slot(d, 10))).status).toBe(400); // ends before it starts
    expect((await book(employee, r, slot(d, 0), slot(d, 13))).status).toBe(400); // longer than 12 hours
    expect((await book(employee, r, 'tomorrow', slot(d, 11))).status).toBe(400);
  });

  it("answers 404 for another company's room", async () => {
    const stranger = await signupOrg();
    const d = nextDay();
    expect((await book(stranger, rooms[0]!, slot(d, 10), slot(d, 11))).status).toBe(404);
  });
});

describe('changing and cancelling', () => {
  it('moves a booking, but not onto another one', async () => {
    const d = nextDay();
    const a = await book(employee, rooms[0]!, slot(d, 9), slot(d, 10));
    await book(other, rooms[0]!, slot(d, 11), slot(d, 12));

    const moved = await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))
      .send({ start: slot(d, 10), end: slot(d, 11), title: 'Moved' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ title: 'Moved', start: slot(d, 10) });

    const clash = await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))
      .send({ start: slot(d, 10, 30), end: slot(d, 11, 30) });
    expect(clash.status).toBe(409);
  });

  it('only the person who booked, or an admin, can change or cancel', async () => {
    const d = nextDay();
    const a = await book(employee, rooms[1]!, slot(d, 9), slot(d, 10));
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(other))).status).toBe(403);
    expect((await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(admin)).send({ title: 'Admin edit' })).status).toBe(200);

    const stranger = await signupOrg();
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(stranger))).status).toBe(404);
  });

  it('cancelling frees the slot', async () => {
    const d = nextDay();
    const a = await book(employee, rooms[1]!, slot(d, 14), slot(d, 15));
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))).status).toBe(204);
    expect((await book(other, rooms[1]!, slot(d, 14), slot(d, 15))).status).toBe(201);
  });
});

describe('reading', () => {
  it("the building schedule covers the building's local day; My bookings lists only mine", async () => {
    const d = nextDay();
    const date = slot(d, 0).slice(0, 10);
    const me = await addMember(admin);
    await book(me, rooms[0]!, `${date}T15:00:00+05:30`, `${date}T16:00:00+05:30`, 'Mine');
    await book(employee, rooms[1]!, `${date}T15:00:00+05:30`, `${date}T16:00:00+05:30`, 'Not mine');

    const day = await api().get(`/api/buildings/${buildingId}/schedule?date=${date}`).set('Authorization', bearer(me));
    expect(day.status).toBe(200);
    expect(day.body.dayStart).toBe(new Date(`${date}T00:00:00+05:30`).toISOString());
    expect(day.body.bookings.map((b: { title: string }) => b.title).sort()).toEqual(['Mine', 'Not mine']);

    const mine = await api().get('/api/bookings/mine').set('Authorization', bearer(me));
    expect(mine.body.map((b: { title: string }) => b.title)).toEqual(['Mine']);
  });
});
