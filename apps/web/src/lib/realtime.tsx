/**
 * One Socket.io connection per signed-in tab.
 *
 * The server only sends a hint ("a booking in building X changed"). On each
 * hint the booking queries are marked stale and React Query re-reads whatever
 * is on screen through the normal API.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import type { BookingChangedMessage, ClientToServerEvents, ServerToClientEvents } from '@roomly/shared';
import { getAccessToken, refreshSession } from './api';
import { keys } from './queries';
import { useSession } from './auth';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type LiveStatus = 'connecting' | 'live' | 'offline';

const RealtimeContext = createContext<{ socket: AppSocket | null; status: LiveStatus }>({ socket: null, status: 'offline' });

const VERBS: Record<BookingChangedMessage['type'], string> = {
  'booking.created': 'booked a room',
  'booking.updated': 'changed a booking',
  'booking.cancelled': 'cancelled a booking',
};

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [toast, setToast] = useState<string>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const s: AppSocket = io({
      path: '/socket.io',
      transports: ['websocket'],
      // Called on every (re)connect, so a reconnect always sends the current token.
      auth: (cb) => cb({ token: getAccessToken() }),
    });

    s.on('connect', () => {
      setStatus('live');
      // Anything that changed while the socket was down was missed, so re-read.
      void qc.invalidateQueries({ queryKey: keys.bookings });
    });
    s.on('disconnect', () => setStatus('connecting'));
    s.on('connect_error', async (err) => {
      setStatus('offline');
      // The access token had expired: get a new one and try again.
      if (err.message === 'UNAUTHORIZED' && (await refreshSession())) s.connect();
    });

    s.on('booking.changed', (msg) => {
      void qc.invalidateQueries({ queryKey: keys.bookings });
      if (msg.actorId !== user.id) {
        clearTimeout(toastTimer.current);
        setToast(`A colleague just ${VERBS[msg.type]}. Updated live.`);
        toastTimer.current = setTimeout(() => setToast(undefined), 3500);
      }
    });

    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [user.id, qc]);

  return (
    <RealtimeContext.Provider value={{ socket, status }}>
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

/** Watches a building for as long as the component is on screen, also after a reconnect. */
export function useLiveBuilding(buildingId: string | undefined) {
  const { socket } = useContext(RealtimeContext);

  useEffect(() => {
    if (!socket || !buildingId) return;
    const subscribe = () => socket.emit('subscribe', buildingId, () => {});
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);
    return () => {
      socket.off('connect', subscribe);
      socket.emit('unsubscribe', buildingId);
    };
  }, [socket, buildingId]);
}
