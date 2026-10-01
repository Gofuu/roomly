import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/db/index.js';
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
    .send({ name, capacity: 6, amenities: ['tv', 'whiteboard'] });

describe('buildings, floors and rooms', () => {
  it('an admin adds a building, a floor and a room; employees can see them but not change them', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    expect((await addRoom(admin, floorId, 'Boardroom')).status).toBe(201);

    const employee = await addMember(admin);
    const tree = await api().get('/api/spaces').set('Authorization', bearer(employee));
    expect(tree.status).toBe(200);
    expect(tree.body[0].floors[0].rooms[0].name).toBe('Boardroom');

    const res = await api().post('/api/buildings').set('Authorization', bearer(employee)).send({ name: 'X', timezone: 'UTC' });
    expect(res.status).toBe(403);
  });

  it('rejects a time zone that does not exist', async () => {
    const admin = await signupOrg();
    const res = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'X', timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it("answers 404 for another company's building, floor or room", async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    const bSpace = await createFloor(b);
    const bRoom = await addRoom(b, bSpace.floorId, 'Private');

    expect((await addRoom(a, bSpace.floorId, 'Sneaky')).status).toBe(404);
    expect((await api().patch(`/api/rooms/${bRoom.body.id}`).set('Authorization', bearer(a)).send({ name: 'Mine' })).status).toBe(404);
    expect((await api().delete(`/api/buildings/${bSpace.buildingId}`).set('Authorization', bearer(a))).status).toBe(404);
  });
});

describe('room limit of the plan (Free = 3 rooms)', () => {
  it('refuses the 4th room with 402', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    for (const n of ['A', 'B', 'C']) expect((await addRoom(admin, floorId, n)).status).toBe(201);

    const fourth = await addRoom(admin, floorId, 'D');
    expect(fourth.status).toBe(402);
    expect(fourth.body.error.code).toBe('PLAN_LIMIT_REACHED');

    const usage = await api().get('/api/plan-usage').set('Authorization', bearer(admin));
    expect(usage.body).toMatchObject({ planId: 'free', roomLimit: 3, activeRooms: 3 });
  });

  it('holds when 6 requests arrive together with one slot left: exactly one succeeds', async () => {
    const admin = await signupOrg();
    const { floorId } = await createFloor(admin);
    await addRoom(admin, floorId, 'A');
    await addRoom(admin, floorId, 'B');

    const results = await Promise.all(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((n) => addRoom(admin, floorId, n)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 402, 402, 402, 402, 402]);
  });
});
