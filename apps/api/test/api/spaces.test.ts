import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemPool } from '../../src/db/index.js';
import { addMember, api, bearer, signupOrg, type TestSession } from '../helpers/api.js';

afterAll(closeDb);

async function createFloor(admin: TestSession) {
  const b = await api().post('/api/buildings').set('Authorization', bearer(admin))
    .send({ name: 'HQ', address: '1 Main St', timezone: 'Europe/London' });
  expect(b.status).toBe(201);
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(admin))
    .send({ name: 'Ground', level: 0 });
  expect(f.status).toBe(201);
  return { buildingId: b.body.id as string, floorId: f.body.id as string };
}

const addRoom = (admin: TestSession, floorId: string, name: string) =>
  api().post(`/api/floors/${floorId}/rooms`).set('Authorization', bearer(admin))
    .send({ name, capacity: 6, amenities: ['tv', 'tv', 'whiteboard'] });

describe('space management', () => {
  it('admin builds building → floor → room; everyone reads the tree', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    const room = await addRoom(admin, floorId, 'Boardroom');
    expect(room.status).toBe(201);
    expect(room.body.amenities).toEqual(['tv', 'whiteboard']); // de-duplicated

    const employee = await addMember(admin);
    const tree = await api().get('/api/spaces').set('Authorization', bearer(employee));
    expect(tree.status).toBe(200);
    expect(tree.body[0].floors[0].rooms[0].name).toBe('Boardroom');
  });

  it('hides inactive rooms from employees but not admins', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    const room = await addRoom(admin, floorId, 'Closet');
    await api().patch(`/api/rooms/${room.body.id}`).set('Authorization', bearer(admin)).send({ isActive: false });
    const employee = await addMember(admin);
    const forEmployee = await api().get('/api/spaces').set('Authorization', bearer(employee));
    const forAdmin = await api().get('/api/spaces').set('Authorization', bearer(admin));
    expect(forEmployee.body[0].floors[0].rooms).toHaveLength(0);
    expect(forAdmin.body[0].floors[0].rooms).toHaveLength(1);
  });

  it('employees cannot modify spaces, but can still reach non-admin routes', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);
    const res = await api().post('/api/buildings').set('Authorization', bearer(employee))
      .send({ name: 'X', timezone: 'UTC' });
    expect(res.status).toBe(403);
    expect((await api().get('/api/me').set('Authorization', bearer(employee))).status).toBe(200);
  });

  it('validates time zones', async () => {
    const admin = await signupOrg();
    const res = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'X', timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it("cannot touch another org's spaces (404, not 403: existence is not revealed)", async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    const bSpace = await createFloor(b);
    const bRoom = await addRoom(b, bSpace.floorId, 'Private');

    expect((await api().post(`/api/buildings/${bSpace.buildingId}/floors`).set('Authorization', bearer(a))
      .send({ name: 'Sneaky', level: 9 })).status).toBe(404);
    expect((await addRoom(a, bSpace.floorId, 'Sneaky')).status).toBe(404);
    expect((await api().patch(`/api/rooms/${bRoom.body.id}`).set('Authorization', bearer(a)).send({ name: 'Mine' })).status).toBe(404);
    expect((await api().delete(`/api/buildings/${bSpace.buildingId}`).set('Authorization', bearer(a))).status).toBe(404);
    expect((await api().patch('/api/rooms/not-a-uuid').set('Authorization', bearer(a)).send({})).status).toBe(404);
  });

  it('refuses to delete a room with booking history', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    const room = await addRoom(admin, floorId, 'Used');
    await systemPool.query(
      `INSERT INTO bookings (org_id, room_id, user_id, title, during)
       VALUES ($1, $2, $3, 'Old meeting', tstzrange('2020-01-01 10:00Z', '2020-01-01 11:00Z', '[)'))`,
      [admin.org.id, room.body.id, admin.user.id],
    );
    const res = await api().delete(`/api/rooms/${room.body.id}`).set('Authorization', bearer(admin));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_BOOKINGS');
  });
});

describe('plan room cap (Free = 3 active rooms)', () => {
  it('blocks the 4th room with 402, and counts reactivation as adding', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await addRoom(admin, floorId, n)).body.id);

    const fourth = await addRoom(admin, floorId, 'D');
    expect(fourth.status).toBe(402);
    expect(fourth.body.error.code).toBe('PLAN_LIMIT_REACHED');

    // Deactivating frees a slot…
    await api().patch(`/api/rooms/${ids[0]}`).set('Authorization', bearer(admin)).send({ isActive: false });
    expect((await addRoom(admin, floorId, 'D')).status).toBe(201);
    // …and reactivating needs one.
    const reactivate = await api().patch(`/api/rooms/${ids[0]}`).set('Authorization', bearer(admin)).send({ isActive: true });
    expect(reactivate.status).toBe(402);

    const usage = await api().get('/api/plan-usage').set('Authorization', bearer(admin));
    expect(usage.body).toMatchObject({ planId: 'free', roomLimit: 3, activeRooms: 3 });
  });

  it('holds under concurrency: 6 simultaneous creates at 2/3 → exactly one succeeds', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    await addRoom(admin, floorId, 'A');
    await addRoom(admin, floorId, 'B');

    const results = await Promise.all(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((n) => addRoom(admin, floorId, n)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 402, 402, 402, 402, 402]);
    const usage = await api().get('/api/plan-usage').set('Authorization', bearer(admin));
    expect(usage.body.activeRooms).toBe(3);
  });
});
