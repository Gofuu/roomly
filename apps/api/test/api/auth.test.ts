import { afterAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { closeDb, systemPool } from '../../src/db/index.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { PASSWORD, addMember, api, bearer, refreshCookieOf, signupOrg, withCookie } from '../helpers/api.js';

afterAll(closeDb);

describe('signup', () => {
  it('creates an org with the user as admin, sets a locked-down refresh cookie', async () => {
    const res = await api().post('/api/auth/signup').send({
      orgName: 'Globex Corporation', name: 'Hank Scorpio', email: `hank-${Date.now()}@globex.test`, password: PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.org).toMatchObject({ name: 'Globex Corporation', planId: 'free' });
    expect(res.body.org.slug).toMatch(/^globex-corporation(-[0-9a-f]{6})?$/);
    expect(res.body).not.toHaveProperty('refreshToken');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const me = await api().get('/api/me').set('Authorization', bearer(res.body));
    expect(me.status).toBe(200);
    expect(me.body.org.id).toBe(res.body.org.id);
  });

  it('rejects a duplicate email (case-insensitively)', async () => {
    const a = await signupOrg();
    const res = await api().post('/api/auth/signup').send({
      orgName: 'Other', name: 'X', email: a.email.toUpperCase(), password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates input', async () => {
    const res = await api().post('/api/auth/signup').send({ orgName: '', name: 'X', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('accepts correct credentials and rejects wrong ones with the same message', async () => {
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
});

describe('access tokens', () => {
  it('rejects missing, malformed, forged and expired tokens', async () => {
    const a = await signupOrg();
    expect((await api().get('/api/me')).status).toBe(401);
    expect((await api().get('/api/me').set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);

    const forged = await new SignJWT({ org: a.org.id, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(a.user.id).setIssuer('roomly').setAudience('roomly-api')
      .setExpirationTime('5m').sign(new TextEncoder().encode('some-other-secret-that-is-long-enough'));
    expect((await api().get('/api/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);

    const expired = await new SignJWT({ org: a.org.id, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(a.user.id).setIssuer('roomly').setAudience('roomly-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    expect((await api().get('/api/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  it("scopes data to the token's org: a valid token for org A cannot see org B's user", async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    // A correctly-signed token that claims B's user id but A's org: RLS filters B's row out.
    const mixed = await signAccessToken({ userId: b.user.id, orgId: a.org.id, role: 'admin' });
    expect((await api().get('/api/me').set('Authorization', `Bearer ${mixed}`)).status).toBe(404);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token on every use', async () => {
    const a = await signupOrg();
    const res = await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = refreshCookieOf(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(a.refreshToken);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const a = await signupOrg();
    const first = await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken));
    const second = refreshCookieOf(first)!;

    // An attacker replays the original (already rotated) token…
    const replay = await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken));
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');

    // …so the legitimate newer token is dead too: everyone must log in again.
    const legit = await api().post('/api/auth/refresh').set('Cookie', withCookie(second));
    expect(legit.status).toBe(401);
  });

  it('only one of two simultaneous refreshes with the same token wins', async () => {
    const a = await signupOrg();
    const results = await Promise.all([
      api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken)),
      api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('logout revokes the session', async () => {
    const a = await signupOrg();
    expect((await api().post('/api/auth/logout').set('Cookie', withCookie(a.refreshToken))).status).toBe(204);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(a.refreshToken))).status).toBe(401);
  });

  it('rejects refresh from a foreign Origin', async () => {
    const a = await signupOrg();
    const res = await api().post('/api/auth/refresh')
      .set('Origin', 'https://evil.example').set('Cookie', withCookie(a.refreshToken));
    expect(res.status).toBe(403);
  });

  it('stops refreshing and logging in once the user is deactivated', async () => {
    const a = await signupOrg();
    const m = await addMember(a);
    await systemPool.query('UPDATE users SET is_active = false WHERE id = $1', [m.user.id]);
    expect((await api().post('/api/auth/refresh').set('Cookie', withCookie(m.refreshToken))).status).toBe(401);
    const login = await api().post('/api/auth/login').send({ email: m.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('invitations', () => {
  it('invite → preview → accept creates an employee in the same org', async () => {
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

    // One-time use.
    const again = await api().post('/api/auth/invitations/accept').send({ token, name: 'Peter', password: PASSWORD });
    expect(again.status).toBe(404);
  });

  it('re-inviting the same email invalidates the previous link', async () => {
    const admin = await signupOrg();
    const email = `x-${Date.now()}@example.test`;
    const first = await api().post('/api/invitations').set('Authorization', bearer(admin)).send({ email });
    await api().post('/api/invitations').set('Authorization', bearer(admin)).send({ email });
    const oldToken = first.body.inviteUrl.split('/invite/')[1];
    expect((await api().get(`/api/auth/invitations/${oldToken}`)).status).toBe(404);
    const list = await api().get('/api/invitations').set('Authorization', bearer(admin));
    expect(list.body.filter((i: { email: string }) => i.email === email)).toHaveLength(1);
  });

  it('refuses to invite an existing member, and refuses acceptance for an email registered elsewhere', async () => {
    const a = await signupOrg();
    const b = await signupOrg();
    const dup = await api().post('/api/invitations').set('Authorization', bearer(a)).send({ email: a.email });
    expect(dup.body.error.code).toBe('ALREADY_MEMBER');

    // Inviting B's admin into A is allowed (no cross-tenant probing)…
    const inv = await api().post('/api/invitations').set('Authorization', bearer(a)).send({ email: b.email });
    expect(inv.status).toBe(201);
    // …but accepting fails, because users belong to exactly one org.
    const token = inv.body.inviteUrl.split('/invite/')[1];
    const res = await api().post('/api/auth/invitations/accept').send({ token, name: 'B', password: PASSWORD });
    expect(res.status).toBe(409);
  });

  it('is admin-only, and an admin cannot revoke another org’s invitation', async () => {
    const a = await signupOrg();
    const employee = await addMember(a, 'employee');
    const denied = await api().post('/api/invitations').set('Authorization', bearer(employee)).send({ email: 'z@example.test' });
    expect(denied.status).toBe(403);

    const b = await signupOrg();
    const inv = await api().post('/api/invitations').set('Authorization', bearer(b)).send({ email: 'q@example.test' });
    const revoke = await api().delete(`/api/invitations/${inv.body.invitation.id}`).set('Authorization', bearer(a));
    expect(revoke.status).toBe(404);
  });

  it('an invited admin gets the admin role', async () => {
    const a = await signupOrg();
    const second = await addMember(a, 'admin');
    expect(second.user.role).toBe('admin');
    const res = await api().get('/api/invitations').set('Authorization', bearer(second));
    expect(res.status).toBe(200);
  });
});
