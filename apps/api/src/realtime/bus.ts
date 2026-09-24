/**
 * In-process event bus between the HTTP layer and the real-time layer.
 *
 * Booking routes publish here only AFTER their transaction has committed, so a
 * listener never announces a booking that was later rolled back. The Socket.io
 * server subscribes and fans events out to clients.
 */
import { EventEmitter } from 'node:events';

export interface BookingChangedEvent {
  type: 'booking.created' | 'booking.updated' | 'booking.cancelled';
  orgId: string;
  buildingId: string;
  roomId: string;
  bookingId: string;
  /** The booking's organizer, whose "My bookings" view should refresh. */
  organizerId: string;
  actorId: string;
}

class Bus extends EventEmitter<{ booking: [BookingChangedEvent] }> {}
export const bus = new Bus();

export function publishBookingChange(event: BookingChangedEvent) {
  bus.emit('booking', event);
}
