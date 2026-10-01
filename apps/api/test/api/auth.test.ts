import { afterAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { closeDb } from '../../src/db/index.js';
import { PASSWORD, addMember, api, bearer, refreshCookieOf, signupOrg, withCookie } from '../helpers/api.js';

afterAll(closeDb);

describe('signup and login', () => {
  it('signup creates a company with the user as admin and sets a locked-down refresh cookie', async () => {
    const res = await api().post('/api/auth/signup').send({
      orgName: 'Globex Corporation', name: 'Hank Scorpio', email: `hank-${Date.now()}@globex.test`, password: PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.org).toMatchObject({ name: 'Globex Corporation', planId: 'free' });

    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const me = await api().get('/api/me').set('Authorization', bearer(res.body));
    expect(me.status).toBe(200);
    expect(me.body.org.id).toBe(res.body.org.id);
  });

  it('rejects an email that is already registered', async () => {
    const a = await signupOrg();
    const res = await api().post('/api/auth/signup').send({
      orgName: 'Other', name: 'X', email: a.email.toUpperCase(), password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('login accepts the right password and gives the same answer for a wrong password and an unknown email', async () => {
    const a = await signupOrg();
    const ok = await api().post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(refreshCookieOf(ok)).toBeTruthy();

    const wrongPw = await api().post('/api/auth/login').send({ email: a.email, password: 'wrong password' });
    const noUser = await api().post('/api/auth/login').send({ email: 'nobody@example.test', password: 'wrong password' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
  });

  it('rejects requests with a missing or forged access token', async () => {
    const a = await signupOrg();
    expect((await api().get('/api/me')).status).toBe(401);
    const forged = await new SignJWT({ org: a.org.id, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(a.user.id).setIssuer('roomly').setAudience('roomly-api')
      .setExpirationTime('5m').sign(new TextEncoder().encode('some-other-secret-that-is-long-enough'));
    expect((await api().get('/api/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('each refresh gives a new token, and the old one stops working', async () => {
    const a = await signupOrg();
    const res = await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = refreshCookieOf(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(a.refreshToken);

    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken))).status).toBe(401);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(next!))).status).toBe(200);
  });

  it('logout ends the session', async () => {
    const a = await signupOrg();
    expect((await api().post('/api/auth/logout').set('Cookie', withCookie(a.refreshToken))).status).toBe(204);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken))).status).toBe(401);
  });
});

describe('invitations', () => {
  it('invite, preview, accept: the new user joins the same company as an employee', async () => {
    const admin = await signupOrg('Initech');
    const email = `peter-${Date.now()}@initech.test`;
    const inv = await api().post('/api/invitations').set('Authorization', bearer(admin)).send({ email });
    expect(inv.status).toBe(201);
    const token = inv.body.inviteUrl.split('/invite/')[1];

    const preview = await api().get(`/api/auth/invitations/${token}`);
    expect(preview.body).toEqual({ email, orgName: 'Initech', role: 'employee' });

    const accepted = await api().post('/api/auth/invitations/accept').send({ token, name: 'Peter Gibbons', password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ email, role: 'employee' });
    expect(accepted.body.org.id).toBe(admin.org.id);

    // A link works once.
    const again = await api().post('/api/auth/invitations/accept').send({ token, name: 'Peter', password: PASSWORD });
    expect(again.status).toBe(404);
  });

  it("only admins can invite, and an admin cannot revoke another company's invitation", async () => {
    const a = await signupOrg();
    const employee = await addMember(a, 'employee');
    const denied = await api().post('/api/invitations').set('Authorization', bearer(employee)).send({ email: 'z@example.test' });
    expect(denied.status).toBe(403);

    const b = await signupOrg();
    const inv = await api().post('/api/invitations').set('Authorization', bearer(b)).send({ email: 'q@example.test' });
    const revoke = await api().delete(`/api/invitations/${inv.body.invitation.id}`).set('Authorization', bearer(a));
    expect(revoke.status).toBe(404);
  });
});
