import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { BookingChangedMessage, ClientToServerEvents, ServerToClientEvents } from '@roomly/shared';
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
let buildingId: string;
let roomId: string;

function open(token: string): Promise<Client> {
  const socket: Client = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const subscribe = (s: Client, id: string) => new Promise<{ ok: boolean }>((resolve) => s.emit('subscribe', id, resolve));

/** Resolves with the next booking.changed message, or with null after `ms`. */
function nextChange(s: Client, ms = 1500) {
  return new Promise<BookingChangedMessage | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    s.once('booking.changed', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

beforeAll(async () => {
  server = createServer(app);
  realtime = attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;

  admin = await signupOrg();
  colleague = await addMember(admin);
  outsider = await signupOrg();
  const auth = bearer(admin);
  const b = await api().post('/api/buildings').set('Authorization', auth).send({ name: 'HQ', timezone: 'UTC' });
  const f = await api().post(`/api/buildings/${b.body.id}/floors`).set('Authorization', auth).send({ name: 'G', level: 0 });
  const r = await api().post(`/api/floors/${f.body.id}/rooms`).set('Authorization', auth).send({ name: 'One', capacity: 4 });
  buildingId = b.body.id;
  roomId = r.body.id;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await realtime.close();
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('live updates', () => {
  it('refuses a connection without a valid access token', async () => {
    await expect(open('garbage')).rejects.toThrow('UNAUTHORIZED');
  });

  it("lets you watch your own company's building, not someone else's", async () => {
    const mine = await open(colleague.accessToken);
    expect(await subscribe(mine, buildingId)).toEqual({ ok: true });
    const theirs = await open(outsider.accessToken);
    expect(await subscribe(theirs, buildingId)).toEqual({ ok: false });
  });

  it('tells everyone watching the building when a booking is saved, and nobody else', async () => {
    const viewer = await open(colleague.accessToken);
    const outsiderSocket = await open(outsider.accessToken);
    await subscribe(viewer, buildingId);
    await subscribe(outsiderSocket, buildingId); // refused

    const seen = nextChange(viewer);
    const notSeen = nextChange(outsiderSocket, 700);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await api().post('/api/bookings').set('Authorization', bearer(admin))
      .send({ roomId, title: 'Live', start: `${day}T10:00:00Z`, end: `${day}T11:00:00Z` });
    expect(res.status).toBe(201);

    expect(await seen).toEqual({
      type: 'booking.created', roomId, buildingId, bookingId: res.body.id, actorId: admin.user.id,
    });
    expect(await notSeen).toBeNull();
  });
});
