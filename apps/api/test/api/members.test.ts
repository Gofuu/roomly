import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/db/index.js';
import { PASSWORD, addMember, api, bearer, signupOrg, withCookie } from '../helpers/api.js';

afterAll(closeDb);

describe('team management', () => {
  it('lists members for admins only', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);
    const list = await api().get('/api/members').set('Authorization', bearer(admin));
    expect(list.body.map((m: { email: string }) => m.email).sort()).toEqual([admin.email, employee.email].sort());
    expect((await api().get('/api/members').set('Authorization', bearer(employee))).status).toBe(403);
  });

  it('never leaves a company without an admin', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);

    const selfDemote = await api().patch(`/api/members/${admin.user.id}`).set('Authorization', bearer(admin)).send({ role: 'employee' });
    expect(selfDemote.status).toBe(409);
    expect(selfDemote.body.error.code).toBe('LAST_ADMIN');

    const promote = await api().patch(`/api/members/${employee.user.id}`).set('Authorization', bearer(admin)).send({ role: 'admin' });
    expect(promote.body.role).toBe('admin');
    const nowOk = await api().patch(`/api/members/${admin.user.id}`).set('Authorization', bearer(admin)).send({ role: 'employee' });
    expect(nowOk.status).toBe(200);
  });

  it('deactivating a member cancels their upcoming bookings and logs them out', async () => {
    const admin = await signupOrg();
    const member = await addMember(admin);
    const auth = bearer(admin);
    const b = await api().post('/api/buildings').set('Authorization', auth).send({ name: 'HQ', timezone: 'UTC' });
    const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', auth).send({ name: 'G', level: 0 });
    const r = await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', auth).send({ name: 'R', capacity: 4 });

    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const booked = await api().post('/api/bookings').set('Authorization', bearer(member))
      .send({ roomId: r.body.id, title: 'Standup', start: `${day}T10:00:00Z`, end: `${day}T11:00:00Z` });
    expect(booked.status).toBe(201);

    const res = await api().patch(`/api/members/${member.user.id}`).set('Authorization', auth).send({ isActive: false });
    expect(res.status).toBe(200);

    const schedule = await api().get(`/api/buildings/${b.body.id}/schedule?date=${day}`).set('Authorization', auth);
    expect(schedule.body.bookings).toEqual([]);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(member.refreshToken))).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: member.email, password: PASSWORD })).status).toBe(403);
  });

  it("cannot change another company's member", async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    const res = await api().patch(`/api/members/${b.user.id}`).set('Authorization', bearer(a)).send({ role: 'employee' });
    expect(res.status).toBe(404);
  });
});
