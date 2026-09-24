import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { SignJWT } from 'jose';
import type { Ack, BookingChangedMessage, ClientToServerEvents, PresenceMessage, ServerToClientEvents } from '@roomly/shared';
import { closeDb } from '../../src/db/index.js';
import { attachRealtime } from '../../src/realtime/socket.js';
import { addMember, api, app, bearer, signupOrg, type TestSession } from '../helpers/api.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let server: Server;
let realtime: ReturnType<typeof attachRealtime>;
let url: string;
const clients: Client[] = [];

let admin: TestSession;
let colleague: TestSession;
let outsider: TestSession;
let bystander: TestSession;
let buildingId: string;
let roomId: string;
let otherRoomId: string;

function open(token: string): Promise<Client> {
  const socket: Client = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const subscribe = (s: Client, kind: 'room' | 'building', id: string) =>
  new Promise<Ack>((resolve) => s.emit('subscribe', { kind, id }, resolve));

/** Resolves with the next `event`, or with null after `ms`. */
function next<E extends keyof ServerToClientEvents>(s: Client, event: E, ms = 1500) {
  return new Promise<Parameters<ServerToClientEvents[E]>[0] | null>((resolve) => {
    const timer = setTimeout(() => { s.off(event, handler as never); resolve(null); }, ms);
    const handler = (msg: Parameters<ServerToClientEvents[E]>[0]) => { clearTimeout(timer); resolve(msg); };
    s.once(event, handler as never);
  });
}

function tomorrowAt(hh: number, dayOffset = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 + dayOffset);
  d.setUTCHours(hh);
  return d.toISOString();
}

beforeAll(async () => {
  server = createServer(app);
  realtime = attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;

  admin = await signupOrg();
  colleague = await addMember(admin);
  bystander = await addMember(admin);
  outsider = await signupOrg();
  const b = await api().post('/api/buildings').set('Authorization', bearer(admin)).send({ name: 'HQ', timezone: 'UTC' });
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', bearer(admin)).send({ name: 'G', level: 0 });
  const r1 = await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: 'One', capacity: 4 });
  const r2 = await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', bearer(admin)).send({ name: 'Two', capacity: 4 });
  buildingId = b.body.id;
  roomId = r1.body.id;
  otherRoomId = r2.body.id;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await realtime.close();
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('socket authentication', () => {
  it('refuses connections without a valid access token', async () => {
    await expect(open('garbage')).rejects.toThrow('UNAUTHORIZED');
    await expect(open('')).rejects.toThrow('UNAUTHORIZED');
  });

  it('disconnects the socket when its access token expires', async () => {
    const shortLived = await new SignJWT({ org: admin.org.id, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(admin.user.id).setIssuer('roomly').setAudience('roomly-api')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    const s = await open(shortLived);
    const reason = await new Promise((resolve) => s.on('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
  });
});

describe('channel subscriptions', () => {
  it("allows subscribing to your org's rooms and buildings only", async () => {
    const mine = await open(colleague.accessToken);
    expect(await subscribe(mine, 'room', roomId)).toEqual({ ok: true });
    expect(await subscribe(mine, 'building', buildingId)).toEqual({ ok: true });

    const theirs = await open(outsider.accessToken);
    expect(await subscribe(theirs, 'room', roomId)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await subscribe(theirs, 'building', buildingId)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await subscribe(theirs, 'room', 'not-a-uuid')).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('live booking updates', () => {
  it('pushes a committed booking to viewers of that room and building, and nobody else', async () => {
    const roomViewer = await open(colleague.accessToken);
    const buildingViewer = await open(admin.accessToken);
    // Same org, watching a different room, and not the organizer: should hear nothing.
    const otherRoomViewer = await open(bystander.accessToken);
    const outsiderSocket = await open(outsider.accessToken);
    await subscribe(roomViewer, 'room', roomId);
    await subscribe(buildingViewer, 'building', buildingId);
    await subscribe(otherRoomViewer, 'room', otherRoomId);

    const expectations = [
      next(roomViewer, 'booking.changed'),
      next(buildingViewer, 'booking.changed'),
      next(otherRoomViewer, 'booking.changed', 700),
      next(outsiderSocket, 'booking.changed', 700),
    ];
    const res = await api().post('/api/bookings').set('Authorization', bearer(admin))
      .send({ roomId, title: 'Live', start: tomorrowAt(10), end: tomorrowAt(11) });
    expect(res.status).toBe(201);

    const [a, b, c, d] = await Promise.all(expectations);
    const expected: BookingChangedMessage = {
      type: 'booking.created', roomId, buildingId, bookingId: res.body.id, actorId: admin.user.id,
    };
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(c).toBeNull();
    expect(d).toBeNull();
  });

  it('sends nothing for a rejected (409) booking', async () => {
    const viewer = await open(colleague.accessToken);
    await subscribe(viewer, 'room', roomId);
    await api().post('/api/bookings').set('Authorization', bearer(admin))
      .send({ roomId, title: 'First', start: tomorrowAt(14, 1), end: tomorrowAt(15, 1) });
    await new Promise((r) => setTimeout(r, 100)); // let the first event arrive

    const pending = next(viewer, 'booking.changed', 700);
    const clash = await api().post('/api/bookings').set('Authorization', bearer(colleague))
      .send({ roomId, title: 'Second', start: tomorrowAt(14, 1), end: tomorrowAt(15, 1) });
    expect(clash.status).toBe(409);
    expect(await pending).toBeNull();
  });

  it("notifies the organizer's personal channel when an admin cancels their booking", async () => {
    const organizer = await open(colleague.accessToken); // subscribed to nothing explicitly
    const created = await api().post('/api/bookings').set('Authorization', bearer(colleague))
      .send({ roomId: otherRoomId, title: 'Mine', start: tomorrowAt(9, 2), end: tomorrowAt(10, 2) });
    await new Promise((r) => setTimeout(r, 100));
    const pending = next(organizer, 'booking.changed');
    await api().delete(`/api/bookings/${created.body.id}`).set('Authorization', bearer(admin));
    expect(await pending).toMatchObject({ type: 'booking.cancelled', bookingId: created.body.id, actorId: admin.user.id });
  });
});

describe('presence', () => {
  it('tells viewers of a room who else is looking at it', async () => {
    // Start from an empty audience: close sockets left over from earlier tests.
    for (const c of clients.splice(0)) c.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    const a = await open(admin.accessToken);
    await subscribe(a, 'room', otherRoomId);
    const b = await open(colleague.accessToken);
    const seenByA = next(a, 'presence');
    await subscribe(b, 'room', otherRoomId);
    const msg = (await seenByA) as PresenceMessage;
    expect(msg.kind).toBe('room');
    expect(msg.viewers.map((v) => v.id).sort()).toEqual([admin.user.id, colleague.user.id].sort());

    const afterLeave = next(a, 'presence');
    b.disconnect();
    expect(((await afterLeave) as PresenceMessage).viewers.map((v) => v.id)).toEqual([admin.user.id]);
  });
});
