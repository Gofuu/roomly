import { z } from 'zod';
import type { Amenity } from './spaces.js';

/** ISO 8601 with an explicit offset or Z, e.g. 2030-01-01T10:00:00+05:30. */
const isoDateTime = z.string().datetime({ offset: true });
const wholeMinute = (iso: string) => {
  const d = new Date(iso);
  return d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
};

export const MAX_BOOKING_HOURS = 12;
export const MAX_DAYS_AHEAD = 180;

const bookingTimes = z.object({
  start: isoDateTime.refine(wholeMinute, 'Must be on a whole minute'),
  end: isoDateTime.refine(wholeMinute, 'Must be on a whole minute'),
});

function checkRange(v: { start?: string; end?: string }, ctx: z.RefinementCtx) {
  if (!v.start || !v.end) return;
  const ms = new Date(v.end).getTime() - new Date(v.start).getTime();
  if (ms <= 0) ctx.addIssue({ code: 'custom', path: ['end'], message: 'End must be after start' });
  else if (ms > MAX_BOOKING_HOURS * 3_600_000) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: `Bookings can be at most ${MAX_BOOKING_HOURS} hours` });
  }
}

export const createBookingSchema = bookingTimes
  .extend({
    roomId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
  })
  .superRefine(checkRange);
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/** Title and/or time change. Start and end must be sent together. */
export const updateBookingSchema = bookingTimes
  .partial()
  .extend({ title: z.string().trim().min(1).max(200).optional() })
  .refine((v) => (v.start === undefined) === (v.end === undefined), { message: 'Send start and end together' })
  .superRefine(checkRange);
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const rangeQuerySchema = z.object({ from: isoDateTime, to: isoDateTime });

export const availabilityQuerySchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  buildingId: z.string().uuid().optional(),
  minCapacity: z.coerce.number().int().min(1).max(500).optional(),
  amenities: z.string().optional().transform((s) => (s ? s.split(',').filter(Boolean) : [])),
});

export interface Booking {
  id: string;
  roomId: string;
  title: string;
  /** ISO timestamps (UTC). Display them in the building's time zone. */
  start: string;
  end: string;
  status: 'confirmed' | 'cancelled';
  organizer: { id: string; name: string };
  isMine: boolean;
  /** The caller may edit or cancel it (organizer, or an admin). */
  canManage: boolean;
}

export interface MyBooking extends Booking {
  roomName: string;
  buildingId: string;
  buildingName: string;
  timezone: string;
}

export interface ScheduleRoom {
  id: string;
  name: string;
  capacity: number;
  amenities: Amenity[];
  floorName: string;
  floorLevel: number;
}

export interface BuildingSchedule {
  building: { id: string; name: string; timezone: string };
  date: string;
  dayStart: string;
  dayEnd: string;
  rooms: ScheduleRoom[];
  bookings: Booking[];
}

export interface RoomSchedule {
  room: ScheduleRoom & { isActive: boolean; buildingId: string; buildingName: string; timezone: string };
  bookings: Booking[];
}

export interface AvailableRoom extends ScheduleRoom {
  buildingId: string;
  buildingName: string;
  timezone: string;
}

/** Details of a 409 BOOKING_CONFLICT response. */
export interface BookingConflictDetails {
  conflicts: { start: string; end: string; title: string; organizerName: string }[];
}
