/** Socket.io contract between the API and the web app. */

export type ChannelKind = 'room' | 'building';

export interface SubscribeRequest {
  kind: ChannelKind;
  id: string;
}

export type Ack = { ok: true } | { ok: false; error: string };

/** Sent after a booking change commits. It is a hint to refetch, not the data itself. */
export interface BookingChangedMessage {
  type: 'booking.created' | 'booking.updated' | 'booking.cancelled';
  roomId: string;
  buildingId: string;
  bookingId: string;
  /** Lets a client skip its own echo (it already refreshed after the request). */
  actorId: string;
}

/** Who else is looking at a room's calendar right now. */
export interface PresenceMessage {
  kind: ChannelKind;
  id: string;
  viewers: { id: string; name: string }[];
}

export interface ServerToClientEvents {
  'booking.changed': (msg: BookingChangedMessage) => void;
  presence: (msg: PresenceMessage) => void;
}

export interface ClientToServerEvents {
  subscribe: (req: SubscribeRequest, ack: (res: Ack) => void) => void;
  unsubscribe: (req: SubscribeRequest) => void;
}
