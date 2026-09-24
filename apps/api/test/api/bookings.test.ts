import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingChangedEvent } from '../../src/realtime/bus.js';
import { bus } from '../../src/realtime/bus.js';
import { closeDb } from '../../src/db/index.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

afterAll(closeDb);

/** A UTC instant `days` days from today at hh:mm, as ISO. */
let dayCursor = 2;
function slot(days: number, hh: number, mm = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm);
  return d.toISOString();
}
const nextDay = () => dayCursor++;

let admin: TestSession;
let employee: TestSession;
let other: TestSession;
let buildingId: string;
let rooms: string[];

async function createSpace(s: TestSession, timezone: string, roomSpecs: { name: string; capacity: number; amenities?: string[] }[]) {
  const b = await api().post('/api/buildings').set('Authorization', bearer(s)).send({ name: `B ${timezone}`, timezone });
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(s)).send({ name: 'G', level: 0 });
  const ids: string[] = [];
  for (const r of roomSpecs) {
    ids.push((await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(s)).send(r)).body.id);
  }
  return { buildingId: b.body.id as string, rooms: ids };
}

const book = (s: TestSession, roomId: string, start: string, end: string, title = 'Sync') =>
  api().post('/api/bookings').set('Authorization', bearer(s)).send({ roomId, title, start, end });

beforeAll(async () => {
  admin = await signupOrg();
  employee = await addMember(admin);
  other = await addMember(admin);
  ({ buildingId, rooms } = await createSpace(admin, 'Asia/Kolkata', [
    { name: 'Small', capacity: 4, amenities: ['tv'] },
    { name: 'Large', capacity: 12, amenities: ['tv', 'video'] },
    { name: 'Spare', capacity: 6 },
  ]));
});

describe('creating bookings', () => {
  it('books a room and rejects an overlap with 409 + the conflicting booking', async () => {
    const d = nextDay();
    const ok = await book(employee, rooms[0]!, slot(d, 10), slot(d, 11), 'Planning');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: 'Planning', isMine: true, canManage: true, start: slot(d, 10), end: slot(d, 11) });

    const clash = await book(other, rooms[0]!, slot(d, 10, 30), slot(d, 11, 30));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('BOOKING_CONFLICT');
    expect(clash.body.error.details.conflicts).toEqual([
      { start: slot(d, 10), end: slot(d, 11), title: 'Planning', organizerName: 'Mo Member' },
    ]);

    expect((await book(other, rooms[0]!, slot(d, 11), slot(d, 12))).status).toBe(201); // back-to-back
    expect((await book(other, rooms[1]!, slot(d, 10), slot(d, 11))).status).toBe(201); // other room
  });

  it('20 simultaneous HTTP requests for one slot → exactly one 201, nineteen 409s', async () => {
    const d = nextDay();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => book(i % 2 ? employee : other, rooms[2]!, slot(d, 9), slot(d, 10))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(19).fill(409)]);
  });

  it('validates times', async () => {
    const d = nextDay();
    const r = rooms[0]!;
    expect((await book(employee, r, slot(-1, 10), slot(-1, 11))).status).toBe(400); // past
    expect((await book(employee, r, slot(d, 11), slot(d, 10))).status).toBe(400); // end before start
    expect((await book(employee, r, slot(d, 0), slot(d, 13))).status).toBe(400); // > 12h
    expect((await book(employee, r, slot(d, 10).replace(':00.000Z', ':30.000Z'), slot(d, 11))).status).toBe(400); // seconds
    expect((await book(employee, r, slot(200, 10), slot(200, 11))).status).toBe(400); // too far ahead
    expect((await book(employee, r, 'tomorrow', slot(d, 11))).status).toBe(400);
  });

  it('accepts local-time offsets and stores the absolute instant', async () => {
    const d = nextDay();
    const date = slot(d, 0).slice(0, 10);
    const res = await book(employee, rooms[1]!, `${date}T15:00:00+05:30`, `${date}T15:30:00+05:30`);
    expect(res.status).toBe(201);
    expect(res.body.start).toBe(slot(d, 9, 30)); // 15:00 IST = 09:30 UTC
  });

  it('404s for inactive rooms and other orgs’ rooms', async () => {
    const d = nextDay();
    await api().patch(`/api/rooms/${rooms[2]}`).set('Authorization', bearer(admin)).send({ isActive: false });
    expect((await book(employee, rooms[2]!, slot(d, 10), slot(d, 11))).status).toBe(404);
    await api().patch(`/api/rooms/${rooms[2]}`).set('Authorization', bearer(admin)).send({ isActive: true });

    const stranger = await signupOrg();
    expect((await book(stranger, rooms[0]!, slot(d, 10), slot(d, 11))).status).toBe(404);
  });
});

describe('changing and cancelling', () => {
  it('reschedules, rejecting moves onto another booking', async () => {
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
    // Extending within its own old range must not conflict with itself.
    const self = await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))
      .send({ start: slot(d, 10), end: slot(d, 10, 45) });
    expect(self.status).toBe(200);
  });

  it('only the organizer or an admin can change or cancel', async () => {
    const d = nextDay();
    const a = await book(employee, rooms[1]!, slot(d, 9), slot(d, 10));
    expect((await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(other)).send({ title: 'Mine now' })).status).toBe(403);
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(other))).status).toBe(403);
    expect((await api().patch(`/api/bookings/${a.body.id}`).set('Authorization', bearer(admin)).send({ title: 'Admin edit' })).status).toBe(200);

    const stranger = await signupOrg();
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(stranger))).status).toBe(404);
  });

  it('cancelling frees the slot; cancelling twice is a 404', async () => {
    const d = nextDay();
    const a = await book(employee, rooms[1]!, slot(d, 14), slot(d, 15));
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))).status).toBe(204);
    expect((await book(other, rooms[1]!, slot(d, 14), slot(d, 15))).status).toBe(201);
    expect((await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee))).status).toBe(404);
  });
});

describe('reading schedules', () => {
  it("building schedule uses the building's local day", async () => {
    const d = nextDay();
    const date = slot(d, 0).slice(0, 10);
    // 23:30–00:30 IST spans two local days; 00:30–01:00 IST is only on the second.
    await book(employee, rooms[0]!, `${date}T23:30:00+05:30`, `${nextDate(date)}T00:30:00+05:30`, 'Late');
    await book(employee, rooms[1]!, `${nextDate(date)}T00:30:00+05:30`, `${nextDate(date)}T01:00:00+05:30`, 'Early');

    const day1 = await api().get(`/api/buildings/${buildingId}/schedule?date=${date}`).set('Authorization', bearer(employee));
    const day2 = await api().get(`/api/buildings/${buildingId}/schedule?date=${nextDate(date)}`).set('Authorization', bearer(employee));
    expect(day1.status).toBe(200);
    expect(day1.body.dayStart).toBe(new Date(`${date}T00:00:00+05:30`).toISOString());
    expect(day1.body.rooms.map((r: { name: string }) => r.name)).toEqual(['Large', 'Small', 'Spare']);
    expect(day1.body.bookings.map((b: { title: string }) => b.title)).toContain('Late');
    expect(day1.body.bookings.map((b: { title: string }) => b.title)).not.toContain('Early');
    expect(day2.body.bookings.map((b: { title: string }) => b.title)).toEqual(expect.arrayContaining(['Late', 'Early']));
  });

  it('a DST-change day in London is 23 hours long', async () => {
    const { buildingId: london } = await createSpace(admin, 'Europe/London', [{ name: 'Thames', capacity: 8 }]);
    const res = await api().get(`/api/buildings/${london}/schedule?date=2030-03-31`).set('Authorization', bearer(employee));
    const hours = (Date.parse(res.body.dayEnd) - Date.parse(res.body.dayStart)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('room calendar returns bookings in a range', async () => {
    const d = nextDay();
    await book(employee, rooms[2]!, slot(d, 8), slot(d, 9), 'In range');
    const res = await api().get(`/api/rooms/${rooms[2]}/bookings`)
      .query({ from: slot(d, 0), to: slot(d + 1, 0) }).set('Authorization', bearer(other));
    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ name: 'Spare', timezone: 'Asia/Kolkata' });
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0]).toMatchObject({ title: 'In range', isMine: false, canManage: false });
  });

  it('availability excludes busy rooms and applies filters', async () => {
    const d = nextDay();
    await book(employee, rooms[1]!, slot(d, 10), slot(d, 11));
    const q = (extra: Record<string, string>) =>
      api().get('/api/availability').query({ from: slot(d, 10, 30), to: slot(d, 11, 30), buildingId, ...extra })
        .set('Authorization', bearer(employee));

    expect((await q({})).body.map((r: { name: string }) => r.name)).toEqual(['Small', 'Spare']);
    expect((await q({ minCapacity: '5' })).body.map((r: { name: string }) => r.name)).toEqual(['Spare']);
    expect((await q({ amenities: 'tv' })).body.map((r: { name: string }) => r.name)).toEqual(['Small']);
  });

  it("my bookings lists only the caller's upcoming bookings", async () => {
    const s = await addMember(admin);
    const d = nextDay();
    await book(s, rooms[0]!, slot(d, 16), slot(d, 17), 'Mine');
    await book(employee, rooms[1]!, slot(d, 16), slot(d, 17), 'Not mine');
    const res = await api().get('/api/bookings/mine').set('Authorization', bearer(s));
    expect(res.body.map((b: { title: string }) => b.title)).toEqual(['Mine']);
    expect(res.body[0]).toMatchObject({ roomName: 'Small', timezone: 'Asia/Kolkata' });
  });
});

describe('change events', () => {
  it('publishes after commit, and nothing for a rejected booking', async () => {
    const events: BookingChangedEvent[] = [];
    const listener = (e: BookingChangedEvent) => events.push(e);
    bus.on('booking', listener);
    try {
      const d = nextDay();
      const a = await book(employee, rooms[0]!, slot(d, 10), slot(d, 11));
      await book(other, rooms[0]!, slot(d, 10), slot(d, 11)); // 409
      await api().delete(`/api/bookings/${a.body.id}`).set('Authorization', bearer(employee));
      expect(events.map((e) => e.type)).toEqual(['booking.created', 'booking.cancelled']);
      expect(events[0]).toMatchObject({ orgId: admin.org.id, buildingId, roomId: rooms[0], bookingId: a.body.id });
    } finally {
      bus.off('booking', listener);
    }
  });
});

function nextDate(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
