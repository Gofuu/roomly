/** Socket.io messages between the API and the web app. */

/** Sent after a booking change is saved. It is a hint to re-read the schedule, not the data itself. */
export interface BookingChangedMessage {
  type: 'booking.created' | 'booking.updated' | 'booking.cancelled';
  roomId: string;
  buildingId: string;
  bookingId: string;
  /** Who made the change, so a browser can tell its own changes from a colleague's. */
  actorId: string;
}

export interface ServerToClientEvents {
  'booking.changed': (msg: BookingChangedMessage) => void;
}

export interface ClientToServerEvents {
  /** Start watching a building's schedule. */
  subscribe: (buildingId: string, ack: (res: { ok: boolean }) => void) => void;
  unsubscribe: (buildingId: string) => void;
}
