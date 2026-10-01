/**
 * Live updates over Socket.io.
 *
 * - Connecting: the browser sends its access token in the handshake. Without a
 *   valid token the connection is refused.
 * - Subscribing: a browser asks to watch one building. The server looks the
 *   building up under row-level security first, so nobody can listen to another
 *   company's calendar even if they know its id.
 * - Updates: after a booking change has been committed, everyone watching that
 *   building gets a small "something changed" message and re-reads the schedule
 *   through the normal API. The message carries no booking data itself.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@roomly/shared';
import { config } from '../config.js';
import { withTenant } from '../db/index.js';
import { verifyAccessToken, type AccessClaims } from '../auth/tokens.js';
import { bus, type BookingChangedEvent } from './bus.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const buildingChannel = (orgId: string, buildingId: string) => `org:${orgId}:building:${buildingId}`;

export function attachRealtime(httpServer: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { auth: AccessClaims }>(
    httpServer,
    { path: '/socket.io', cors: { origin: config.webOrigin, credentials: true } },
  );

  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    const claims = typeof token === 'string' ? await verifyAccessToken(token) : null;
    if (!claims) return next(new Error('UNAUTHORIZED'));
    socket.data.auth = claims;
    next();
  });

  io.on('connection', (socket) => {
    const { orgId } = socket.data.auth;

    socket.on('subscribe', async (buildingId, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const visible = typeof buildingId === 'string' && UUID.test(buildingId) && await withTenant(orgId, (tx) =>
        tx.selectFrom('buildings').select('id').where('id', '=', buildingId).executeTakeFirst(),
      ).catch(() => undefined);
      if (!visible) return reply({ ok: false });
      await socket.join(buildingChannel(orgId, buildingId));
      reply({ ok: true });
    });

    socket.on('unsubscribe', (buildingId) => {
      if (typeof buildingId === 'string') void socket.leave(buildingChannel(orgId, buildingId));
    });
  });

  const onBooking = (e: BookingChangedEvent) => {
    io.to(buildingChannel(e.orgId, e.buildingId)).emit('booking.changed', {
      type: e.type, roomId: e.roomId, buildingId: e.buildingId, bookingId: e.bookingId, actorId: e.actorId,
    });
  };
  bus.on('booking', onBooking);

  return {
    io,
    close: async () => {
      bus.off('booking', onBooking);
      await io.close();
    },
  };
}
