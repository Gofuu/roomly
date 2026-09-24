import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemPool } from '../../src/db/index.js';
import { addMember, api, bearer, signupOrg, withCookie } from '../helpers/api.js';

afterAll(closeDb);

describe('team management', () => {
  it('lists members for admins only', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);
    const list = await api().get('/api/members').set('Authorization', bearer(admin));
    expect(list.body.map((m: { email: string }) => m.email).sort()).toEqual([admin.email, employee.email].sort());
    expect((await api().get('/api/members').set('Authorization', bearer(employee))).status).toBe(403);
  });

  it('promotes and demotes, but never leaves the org without an active admin', async () => {
    const admin = await signupOrg();
    const employee = await addMember(admin);

    const selfDemote = await api().patch(`/api/members/${admin.user.id}`).set('Authorization', bearer(admin)).send({ role: 'employee' });
    expect(selfDemote.status).toBe(409);
    expect(selfDemote.body.error.code).toBe('LAST_ADMIN');
    const selfDeactivate = await api().patch(`/api/members/${admin.user.id}`).set('Authorization', bearer(admin)).send({ isActive: false });
    expect(selfDeactivate.status).toBe(409);

    const promote = await api().patch(`/api/members/${employee.user.id}`).set('Authorization', bearer(admin)).send({ role: 'admin' });
    expect(promote.body.role).toBe('admin');
    const nowOk = await api().patch(`/api/members/${admin.user.id}`).set('Authorization', bearer(admin)).send({ role: 'employee' });
    expect(nowOk.status).toBe(200);
  });

  it('two admins demoting each other at the same moment: exactly one succeeds', async () => {
    const a = await signupOrg();
    const b = await addMember(a, 'admin');
    const results = await Promise.all([
      api().patch(`/api/members/${b.user.id}`).set('Authorization', bearer(a)).send({ role: 'employee' }),
      api().patch(`/api/members/${a.user.id}`).set('Authorization', bearer(b)).send({ role: 'employee' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await systemPool.query(
      "SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin' AND is_active", [a.org.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('deactivating a member cancels their future bookings and ends their sessions', async () => {
    const admin = await signupOrg();
    const member = await addMember(admin);
    const b = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'HQ', timezone: 'UTC' });
    const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(admin)).send({ name: 'G', level: 0 });
    const r = await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: 'R', capacity: 4 });
    await systemPool.query(
      `INSERT INTO bookings (org_id, room_id, user_id, title, during) VALUES
        ($1, $2, $3, 'past',   tstzrange('2020-01-01 10:00Z', '2020-01-01 11:00Z', '[)')),
        ($1, $2, $3, 'future', tstzrange('2031-01-01 10:00Z', '2031-01-01 11:00Z', '[)'))`,
      [admin.org.id, r.body.id, member.user.id],
    );

    const res = await api().patch(`/api/members/${member.user.id}`).set('Authorization', bearer(admin)).send({ isActive: false });
    expect(res.status).toBe(200);

    const { rows } = await systemPool.query('SELECT title, status FROM bookings WHERE user_id = $1 ORDER BY title', [member.user.id]);
    expect(rows).toEqual([{ title: 'future', status: 'cancelled' }, { title: 'past', status: 'confirmed' }]);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(member.refreshToken))).status).toBe(401);
  });

  it("cannot modify another org's member", async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    const res = await api().patch(`/api/members/${b.user.id}`).set('Authorization', bearer(a)).send({ role: 'employee' });
    expect(res.status).toBe(404);
  });
});
