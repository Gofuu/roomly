import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { AuthSession } from '@roomly/shared';
import { createApp } from '../../src/app.js';
import { REFRESH_COOKIE } from '../../src/auth/routes.js';

export const app = createApp();
export const api = () => request(app);

export const PASSWORD = 'correct horse battery';

/** Pulls the refresh cookie's value out of a response's Set-Cookie headers. */
export function refreshCookieOf(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  const value = cookie?.split(';')[0]!.slice(REFRESH_COOKIE.length + 1);
  return value || undefined;
}

export const withCookie = (token: string) => `${REFRESH_COOKIE}=${token}`;
export const bearer = (s: { accessToken: string }) => `Bearer ${s.accessToken}`;

export interface TestSession extends AuthSession {
  refreshToken: string;
  email: string;
}

/** Signs up a brand-new org; returns its admin's session. */
export async function signupOrg(orgName = `Test Org ${randomUUID().slice(0, 6)}`): Promise<TestSession> {
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api().post('/api/auth/signup').send({ orgName, name: 'Ada Admin', email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, refreshToken: refreshCookieOf(res)!, email };
}

/** Invites a new user into admin's org and accepts the invitation. */
export async function addMember(admin: TestSession, role: 'admin' | 'employee' = 'employee'): Promise<TestSession> {
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await api().post('/api/invitations').set('Authorization', bearer(admin)).send({ email, role });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = (inv.body.inviteUrl as string).split('/invite/')[1];
  const res = await api().post('/api/auth/invitations/accept').send({ token, name: 'Mo Member', password: PASSWORD });
  if (res.status !== 201) throw new Error(`accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, refreshToken: refreshCookieOf(res)!, email };
}
