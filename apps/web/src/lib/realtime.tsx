/**
 * One Socket.io connection per signed-in tab.
 *
 * The server only sends refetch hints ("booking X in room Y changed"); on each
 * hint we invalidate the booking queries and React Query refetches whatever is
 * on screen through the normal, permission-checked REST API.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import type { BookingChangedMessage, ChannelKind, ClientToServerEvents, PresenceMessage, ServerToClientEvents } from '@roomly/shared';
import { getAccessToken, refreshSession } from './api';
import { keys } from './queries';
import { useSession } from './auth';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type LiveStatus = 'connecting' | 'live' | 'offline';

interface RealtimeContextValue {
  socket: AppSocket | null;
  status: LiveStatus;
  presence: Record<string, PresenceMessage['viewers']>;
}

const RealtimeContext = createContext<RealtimeContextValue>({ socket: null, status: 'offline', presence: {} });

const VERBS: Record<BookingChangedMessage['type'], string> = {
  'booking.created': 'booked',
  'booking.updated': 'changed a booking in',
  'booking.cancelled': 'cancelled a booking in',
};

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [presence, setPresence] = useState<Record<string, PresenceMessage['viewers']>>({});
  const [toast, setToast] = useState<string>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const s: AppSocket = io({
      path: '/socket.io',
      transports: ['websocket'],
      // Evaluated on every (re)connect, so a reconnect always carries the current token.
      auth: (cb) => cb({ token: getAccessToken() }),
    });

    const reconnectWithFreshToken = async () => {
      if (await refreshSession()) s.connect();
      else setStatus('offline');
    };

    s.on('connect', () => {
      setStatus('live');
      // Events sent while this socket was down were missed; refetch what's on screen.
      void qc.invalidateQueries({ queryKey: keys.bookings });
    });
    s.on('disconnect', (reason) => {
      setStatus('connecting');
      // The server drops sockets whose access token expired; refresh and come back.
      if (reason === 'io server disconnect') void reconnectWithFreshToken();
    });
    s.on('connect_error', (err) => {
      setStatus('offline');
      if (err.message === 'UNAUTHORIZED') void reconnectWithFreshToken();
    });
    s.io.on('reconnect_attempt', () => setStatus('connecting'));

    s.on('booking.changed', (msg) => {
      void qc.invalidateQueries({ queryKey: keys.bookings });
      if (msg.actorId !== user.id) {
        clearTimeout(toastTimer.current);
        setToast(`A colleague just ${VERBS[msg.type]} a room you're viewing. Updated live.`);
        toastTimer.current = setTimeout(() => setToast(undefined), 3500);
      }
    });
    s.on('presence', (msg) => setPresence((p) => ({ ...p, [`${msg.kind}:${msg.id}`]: msg.viewers })));

    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [user.id, qc]);

  return (
    <RealtimeContext.Provider value={{ socket, status, presence }}>
      {children}
      {toast && (
        <div role="status" className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-emerald-400" />
          {toast}
        </div>
      )}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeStatus() {
  return useContext(RealtimeContext).status;
}

/**
 * Subscribes to a room or building channel while the component is mounted,
 * re-subscribing after every reconnect. Returns who else is viewing it.
 */
export function useLiveChannel(kind: ChannelKind, id: string | undefined) {
  const { socket, presence } = useContext(RealtimeContext);
  const subscribe = useCallback(() => {
    if (socket && id) socket.emit('subscribe', { kind, id }, () => {});
  }, [socket, kind, id]);

  useEffect(() => {
    if (!socket || !id) return;
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);
    return () => {
      socket.off('connect', subscribe);
      socket.emit('unsubscribe', { kind, id });
    };
  }, [socket, kind, id, subscribe]);

  return id ? presence[`${kind}:${id}`] ?? [] : [];
}
