/**
 * Live updates over Socket.io.
 *
 * - Handshake: the client sends its access token; the connection is refused
 *   without a valid one, and dropped when that token expires (the client then
 *   refreshes and reconnects), so a socket never outlives its credentials.
 * - Channels: a client asks to subscribe to a room or building. The server looks
 *   the id up through RLS (withTenant) before joining, so a client can never
 *   listen to another org's calendar even if it knows the UUID. Channel names
 *   also embed the org id.
 * - Messages: after a booking change commits, the bus event is fanned out to
 *   the room's channel, the building's channel and the organizer's personal
 *   channel. Payloads are refetch hints; data still comes from the REST API
 *   with that user's permissions applied.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type {
  ChannelKind, ClientToServerEvents, PresenceMessage, ServerToClientEvents, SubscribeRequest,
} from '@roomly/shared';
import { config } from '../config.js';
import { withTenant } from '../db/index.js';
import { verifyAccessToken, type AccessClaims } from '../auth/tokens.js';
import { bus, type BookingChangedEvent } from './bus.js';

interface SocketData {
  auth: AccessClaims;
  name: string;
}
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const channel = (orgId: string, kind: ChannelKind | 'user', id: string) => `org:${orgId}:${kind}:${id}`;

function parseChannel(name: string): { kind: ChannelKind; id: string } | null {
  const m = /^org:[^:]+:(room|building):(.+)$/.exec(name);
  return m ? { kind: m[1] as ChannelKind, id: m[2]! } : null;
}

/** Can this user see this room/building? Answered by Postgres under RLS. */
async function canSubscribe(auth: AccessClaims, req: SubscribeRequest): Promise<boolean> {
  if (!UUID.test(req.id)) return false;
  return withTenant(auth.orgId, async (tx) => {
    if (req.kind === 'building') {
      return !!(await tx.selectFrom('buildings').select('id').where('id', '=', req.id).executeTakeFirst());
    }
    const room = await tx.selectFrom('rooms').select('is_active').where('id', '=', req.id).executeTakeFirst();
    return !!room && (room.is_active || auth.role === 'admin');
  });
}

export function attachRealtime(httpServer: HttpServer) {
  const io: AppServer = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: config.webOrigin, credentials: true },
  });

  // --- Handshake authentication ---------------------------------------------
  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    const claims = typeof token === 'string' ? await verifyAccessToken(token) : null;
    if (!claims) return next(new Error('UNAUTHORIZED'));
    const user = await withTenant(claims.orgId, (tx) =>
      tx.selectFrom('users').select('name').where('id', '=', claims.userId).where('is_active', '=', true).executeTakeFirst(),
    );
    if (!user) return next(new Error('UNAUTHORIZED'));

    socket.data.auth = { userId: claims.userId, orgId: claims.orgId, role: claims.role };
    socket.data.name = user.name;
    // Disconnect when the token expires; the client refreshes and reconnects.
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
    socket.on('disconnect', () => clearTimeout(timer));
    next();
  });

  // --- Presence ---------------------------------------------------------------
  async function broadcastPresence(name: string) {
    const parsed = parseChannel(name);
    if (!parsed) return;
    const sockets = await io.in(name).fetchSockets();
    const viewers = new Map<string, string>();
    for (const s of sockets) viewers.set(s.data.auth.userId, s.data.name);
    const msg: PresenceMessage = { ...parsed, viewers: [...viewers].map(([id, n]) => ({ id, name: n })) };
    io.to(name).emit('presence', msg);
  }

  // --- Connections --------------------------------------------------------------
  io.on('connection', (socket: AppSocket) => {
    const { orgId, userId } = socket.data.auth;
    socket.join(channel(orgId, 'user', userId));

    socket.on('subscribe', async (req, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      try {
        if (!req || (req.kind !== 'room' && req.kind !== 'building') || !(await canSubscribe(socket.data.auth, req))) {
          return respond({ ok: false, error: 'NOT_FOUND' });
        }
        const name = channel(orgId, req.kind, req.id);
        await socket.join(name);
        respond({ ok: true });
        void broadcastPresence(name);
      } catch {
        respond({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('unsubscribe', async (req) => {
      if (!req || (req.kind !== 'room' && req.kind !== 'building')) return;
      const name = channel(orgId, req.kind, req.id);
      await socket.leave(name);
      void broadcastPresence(name);
    });

    // Remember which channels to update; by 'disconnect' the socket has left them.
    let joined: string[] = [];
    socket.on('disconnecting', () => {
      joined = [...socket.rooms];
    });
    socket.on('disconnect', () => {
      for (const name of joined) void broadcastPresence(name);
    });
  });

  // --- Fan-out of committed booking changes --------------------------------------
  const onBooking = (e: BookingChangedEvent) => {
    // One emit to the union of channels: a socket in several of them gets it once.
    io.to(channel(e.orgId, 'room', e.roomId))
      .to(channel(e.orgId, 'building', e.buildingId))
      .to(channel(e.orgId, 'user', e.organizerId))
      .emit('booking.changed', {
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
