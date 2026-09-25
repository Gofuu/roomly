import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/db/index.js';
import { authRateLimit } from '../../src/http/rate-limit.js';
import { api, app as roomlyApp } from '../helpers/api.js';

afterAll(closeDb);

describe('hardening', () => {
  it('rate-limits auth endpoints per IP with a JSON 429', async () => {
    const app = express().use(authRateLimit(3)).post('/login', (_req, res) => { res.json({ ok: true }); });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(app).post('/login')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await request(app).post('/login');
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers).toHaveProperty('ratelimit-policy');
  });

  it('uses the real client IP behind one proxy hop, so spoofed X-Forwarded-For entries are ignored', async () => {
    expect(roomlyApp.get('trust proxy')).toBe(1);
    const app = express().set('trust proxy', 1).use(authRateLimit(1)).post('/login', (_req, res) => { res.json({ ok: true }); });
    // CloudFront appends the real client IP as the LAST entry; anything before it is client-controlled.
    const as = (xff: string) => request(app).post('/login').set('X-Forwarded-For', xff);
    expect((await as('1.1.1.1')).status).toBe(200);
    expect((await as('1.1.1.1')).status).toBe(429);
    expect((await as('9.9.9.9, 1.1.1.1')).status).toBe(429); // spoofed prefix doesn't help
    expect((await as('2.2.2.2')).status).toBe(200); // a different client has its own budget
  });

  it('health check reports database connectivity', async () => {
    expect((await api().get('/api/health')).body).toEqual({ ok: true });
  });

  it('sets security headers and hides the framework', async () => {
    const res = await api().get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('rejects oversized and malformed JSON bodies cleanly', async () => {
    const big = await api().post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'x'.repeat(200_000) }));
    expect(big.status).toBe(413);
    const bad = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
  });
});
