import { Router, type Request } from 'express';
import { sql } from 'kysely';
import {
  MAX_DAYS_AHEAD, availabilityQuerySchema, createBookingSchema, dateSchema, rangeQuerySchema, updateBookingSchema,
  type AvailableRoom, type Amenity, type Booking, type BookingConflictDetails, type BuildingSchedule, type MyBooking,
  type RoomSchedule, type ScheduleRoom,
} from '@roomly/shared';
import { withTenant, type Tx } from '../db/index.js';
import { auth } from '../auth/middleware.js';
import type { AccessClaims } from '../auth/tokens.js';
import { HttpError, badRequest, forbidden, notFound, pgErrorCode } from '../http/errors.js';
import { param, validateIdParams } from '../http/params.js';
import { publishBookingChange } from '../realtime/bus.js';

export const bookingsRouter = Router();
validateIdParams(bookingsRouter, 'id');

// -----------------------------------------------------------------------------
// Query helpers
// -----------------------------------------------------------------------------

/** Bookings joined with their organizer, with the range split into start/end. */
function bookingQuery(tx: Tx) {
  return tx
    .selectFrom('bookings as b')
    .innerJoin('users as u', 'u.id', 'b.user_id')
    .select([
      'b.id', 'b.room_id', 'b.title', 'b.status', 'b.user_id', 'u.name as organizer_name',
      sql<Date>`lower(b.during)`.as('starts_at'),
      sql<Date>`upper(b.during)`.as('ends_at'),
    ]);
}

type BookingRow = {
  id: string; room_id: string; title: string; status: 'confirmed' | 'cancelled';
  user_id: string; organizer_name: string; starts_at: Date; ends_at: Date;
};

function toBooking(r: BookingRow, me: AccessClaims): Booking {
  const isMine = r.user_id === me.userId;
  return {
    id: r.id,
    roomId: r.room_id,
    title: r.title,
    start: r.starts_at.toISOString(),
    end: r.ends_at.toISOString(),
    status: r.status,
    organizer: { id: r.user_id, name: r.organizer_name },
    isMine,
    canManage: isMine || me.role === 'admin',
  };
}

/** Active-or-not room with its floor and building (for time zone and event routing). */
function roomQuery(tx: Tx) {
  return tx
    .selectFrom('rooms as r')
    .innerJoin('floors as f', 'f.id', 'r.floor_id')
    .innerJoin('buildings as bl', 'bl.id', 'f.building_id')
    .select([
      'r.id', 'r.name', 'r.capacity', 'r.amenities', 'r.is_active',
      'f.name as floor_name', 'f.level as floor_level',
      'bl.id as building_id', 'bl.name as building_name', 'bl.timezone',
    ]);
}

type RoomRow = {
  id: string; name: string; capacity: number; amenities: string[]; is_active: boolean;
  floor_name: string; floor_level: number; building_id: string; building_name: string; timezone: string;
};
const toScheduleRoom = (r: RoomRow): ScheduleRoom => ({
  id: r.id, name: r.name, capacity: r.capacity, amenities: r.amenities as Amenity[],
  floorName: r.floor_name, floorLevel: r.floor_level,
});

const tstzrange = (start: string | Date, end: string | Date) =>
  sql<string>`tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')`;

function assertBookableWindow(start: string) {
  const startMs = new Date(start).getTime();
  // Five minutes of grace so "book the room right now" works despite clock skew.
  if (startMs < Date.now() - 5 * 60_000) throw badRequest('Bookings cannot start in the past');
  if (startMs > Date.now() + MAX_DAYS_AHEAD * 86_400_000) {
    throw badRequest(`Bookings can be made at most ${MAX_DAYS_AHEAD} days ahead`);
  }
}

/**
 * Turns the database's 23P01 into a helpful 409: which bookings are in the way.
 * Runs in a fresh transaction, since the failed one has been rolled back.
 */
async function conflictError(me: AccessClaims, roomId: string, start: string, end: string, excludeId?: string) {
  const rows = await withTenant(me.orgId, (tx) =>
    bookingQuery(tx)
      .where('b.room_id', '=', roomId)
      .where('b.status', '=', 'confirmed')
      .where(sql<boolean>`b.during && ${tstzrange(start, end)}`)
      .$if(!!excludeId, (q) => q.where('b.id', '<>', excludeId!))
      .orderBy('starts_at')
      .execute(),
  );
  const details: BookingConflictDetails = {
    conflicts: rows.map((r) => ({
      start: r.starts_at.toISOString(), end: r.ends_at.toISOString(), title: r.title, organizerName: r.organizer_name,
    })),
  };
  return new HttpError(409, 'BOOKING_CONFLICT', 'That room is already booked for part of that time', details);
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** One building's bookable rooms and the day's bookings, where "day" is local to the building. */
bookingsRouter.get('/buildings/:id/schedule', async (req, res) => {
  const me = auth(req);
  const date = dateSchema.parse(req.query.date);
  const buildingId = param(req, 'id');

  const body = await withTenant(me.orgId, async (tx): Promise<BuildingSchedule | undefined> => {
    // Local midnight → absolute instants, computed by Postgres so DST days are 23 or 25 hours long.
    const building = await tx
      .selectFrom('buildings')
      .select([
        'id', 'name', 'timezone',
        sql<Date>`(${date}::date)::timestamp AT TIME ZONE timezone`.as('day_start'),
        sql<Date>`(${date}::date + 1)::timestamp AT TIME ZONE timezone`.as('day_end'),
      ])
      .where('id', '=', buildingId)
      .executeTakeFirst();
    if (!building) return undefined;

    const [rooms, bookings] = await Promise.all([
      roomQuery(tx).where('bl.id', '=', buildingId).where('r.is_active', '=', true)
        .orderBy('f.level').orderBy('r.name').execute(),
      bookingQuery(tx)
        .innerJoin('rooms as r', 'r.id', 'b.room_id')
        .innerJoin('floors as f', 'f.id', 'r.floor_id')
        .where('f.building_id', '=', buildingId)
        .where('b.status', '=', 'confirmed')
        .where(sql<boolean>`b.during && ${tstzrange(building.day_start, building.day_end)}`)
        .orderBy('starts_at')
        .execute(),
    ]);
    return {
      building: { id: building.id, name: building.name, timezone: building.timezone },
      date,
      dayStart: building.day_start.toISOString(),
      dayEnd: building.day_end.toISOString(),
      rooms: rooms.map(toScheduleRoom),
      bookings: bookings.map((b) => toBooking(b, me)),
    };
  });
  if (!body) throw notFound('Building');
  res.json(body);
});

/** One room's bookings in [from, to) — backs the room calendar. */
bookingsRouter.get('/rooms/:id/bookings', async (req, res) => {
  const me = auth(req);
  const { from, to } = rangeQuerySchema.parse(req.query);
  const span = new Date(to).getTime() - new Date(from).getTime();
  if (span <= 0 || span > 42 * 86_400_000) throw badRequest('Range must be positive and at most 42 days');
  const roomId = param(req, 'id');

  const body = await withTenant(me.orgId, async (tx): Promise<RoomSchedule | undefined> => {
    const room = await roomQuery(tx).where('r.id', '=', roomId).executeTakeFirst();
    if (!room || (!room.is_active && me.role !== 'admin')) return undefined;
    // This WHERE is served by the exclusion constraint's GiST index on (room_id, during).
    const bookings = await bookingQuery(tx)
      .where('b.room_id', '=', roomId)
      .where('b.status', '=', 'confirmed')
      .where(sql<boolean>`b.during && ${tstzrange(from, to)}`)
      .orderBy('starts_at')
      .execute();
    return {
      room: {
        ...toScheduleRoom(room), isActive: room.is_active,
        buildingId: room.building_id, buildingName: room.building_name, timezone: room.timezone,
      },
      bookings: bookings.map((b) => toBooking(b, me)),
    };
  });
  if (!body) throw notFound('Room');
  res.json(body);
});

/** Rooms with no confirmed booking overlapping [from, to), optionally filtered. */
bookingsRouter.get('/availability', async (req, res) => {
  const me = auth(req);
  const q = availabilityQuerySchema.parse(req.query);
  if (new Date(q.to) <= new Date(q.from)) throw badRequest('"to" must be after "from"');

  const rows = await withTenant(me.orgId, (tx) =>
    roomQuery(tx)
      .where('r.is_active', '=', true)
      .$if(!!q.buildingId, (qb) => qb.where('bl.id', '=', q.buildingId!))
      .$if(!!q.minCapacity, (qb) => qb.where('r.capacity', '>=', q.minCapacity!))
      .$if(q.amenities.length > 0, (qb) => qb.where(sql<boolean>`r.amenities @> ${q.amenities}::text[]`))
      .where(({ not, exists, selectFrom }) => not(exists(
        selectFrom('bookings as b')
          .select(sql`1`.as('one'))
          .whereRef('b.room_id', '=', 'r.id')
          .where('b.status', '=', 'confirmed')
          .where(sql<boolean>`b.during && ${tstzrange(q.from, q.to)}`),
      )))
      .orderBy('r.capacity').orderBy('r.name')
      .execute(),
  );
  const out: AvailableRoom[] = rows.map((r) => ({
    ...toScheduleRoom(r), buildingId: r.building_id, buildingName: r.building_name, timezone: r.timezone,
  }));
  res.json(out);
});

/** The caller's own bookings, upcoming (default) or past. */
bookingsRouter.get('/bookings/mine', async (req, res) => {
  const me = auth(req);
  const past = req.query.when === 'past';
  const rows = await withTenant(me.orgId, (tx) =>
    bookingQuery(tx)
      .innerJoin('rooms as r', 'r.id', 'b.room_id')
      .innerJoin('floors as f', 'f.id', 'r.floor_id')
      .innerJoin('buildings as bl', 'bl.id', 'f.building_id')
      .select(['r.name as room_name', 'bl.id as building_id', 'bl.name as building_name', 'bl.timezone'])
      .where('b.user_id', '=', me.userId)
      .$if(!past, (q) => q.where('b.status', '=', 'confirmed').where(sql<boolean>`upper(b.during) > now()`))
      .$if(past, (q) => q.where(sql<boolean>`(upper(b.during) <= now() OR b.status = 'cancelled')`))
      .orderBy('starts_at', past ? 'desc' : 'asc')
      .limit(100)
      .execute(),
  );
  const out: MyBooking[] = rows.map((r) => ({
    ...toBooking(r, me), roomName: r.room_name, buildingId: r.building_id, buildingName: r.building_name, timezone: r.timezone,
  }));
  res.json(out);
});

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/**
 * Creates a booking. Note what is NOT here: no "is the slot free?" query before
 * the insert. The insert itself is the check — the exclusion constraint rejects
 * an overlap atomically, even against a concurrent request, and we translate
 * its 23P01 into a 409.
 */
bookingsRouter.post('/bookings', async (req, res) => {
  const me = auth(req);
  const input = createBookingSchema.parse(req.body);
  assertBookableWindow(input.start);

  const result = await withTenant(me.orgId, async (tx) => {
    const room = await roomQuery(tx).where('r.id', '=', input.roomId).executeTakeFirst();
    if (!room || !room.is_active) return undefined;
    const { id } = await tx
      .insertInto('bookings')
      .values({
        org_id: me.orgId,
        room_id: input.roomId,
        user_id: me.userId,
        title: input.title,
        during: tstzrange(input.start, input.end),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await bookingQuery(tx).where('b.id', '=', id).executeTakeFirstOrThrow();
    return { booking: toBooking(row, me), buildingId: room.building_id };
  }).catch(async (err) => {
    if (pgErrorCode(err) === '23P01') throw await conflictError(me, input.roomId, input.start, input.end);
    throw err;
  });
  if (!result) throw notFound('Room');

  publishBookingChange({
    type: 'booking.created', orgId: me.orgId, buildingId: result.buildingId,
    roomId: input.roomId, bookingId: result.booking.id, organizerId: me.userId, actorId: me.userId,
  });
  res.status(201).json(result.booking);
});

/** Loads a confirmed booking the caller may manage, locking it for the update. */
async function loadManageable(tx: Tx, req: Request) {
  const me = auth(req);
  const row = await tx
    .selectFrom('bookings as b')
    .innerJoin('rooms as r', 'r.id', 'b.room_id')
    .innerJoin('floors as f', 'f.id', 'r.floor_id')
    .select([
      'b.id', 'b.room_id', 'b.user_id', 'b.status', 'f.building_id',
      sql<Date>`lower(b.during)`.as('starts_at'),
      sql<Date>`upper(b.during)`.as('ends_at'),
    ])
    .where('b.id', '=', param(req, 'id'))
    .forUpdate('b')
    .executeTakeFirst();
  if (!row || row.status !== 'confirmed') throw notFound('Booking');
  if (row.user_id !== me.userId && me.role !== 'admin') throw forbidden('Only the organizer or an admin can change this booking');
  return row;
}

bookingsRouter.patch('/bookings/:id', async (req, res) => {
  const me = auth(req);
  const input = updateBookingSchema.parse(req.body);

  let roomId: string | undefined;
  const result = await withTenant(me.orgId, async (tx) => {
    const current = await loadManageable(tx, req);
    roomId = current.room_id;
    if (current.ends_at <= new Date()) throw badRequest('Past bookings cannot be changed');
    const timeChanged = input.start !== undefined
      && (new Date(input.start).getTime() !== current.starts_at.getTime()
        || new Date(input.end!).getTime() !== current.ends_at.getTime());
    if (timeChanged && new Date(input.start!).getTime() !== current.starts_at.getTime()) {
      assertBookableWindow(input.start!);
    }

    await tx.updateTable('bookings')
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(timeChanged && { during: tstzrange(input.start!, input.end!) }),
        updated_at: sql`now()`,
      })
      .where('id', '=', current.id)
      .execute();
    const row = await bookingQuery(tx).where('b.id', '=', current.id).executeTakeFirstOrThrow();
    return { booking: toBooking(row, me), buildingId: current.building_id };
  }).catch(async (err) => {
    if (pgErrorCode(err) === '23P01' && roomId) {
      throw await conflictError(me, roomId, input.start!, input.end!, param(req, 'id'));
    }
    throw err;
  });

  publishBookingChange({
    type: 'booking.updated', orgId: me.orgId, buildingId: result.buildingId,
    roomId: result.booking.roomId, bookingId: result.booking.id, organizerId: result.booking.organizer.id, actorId: me.userId,
  });
  res.json(result.booking);
});

/** Cancels (soft-deletes) a booking. The row stays for history; the slot is freed. */
bookingsRouter.delete('/bookings/:id', async (req, res) => {
  const me = auth(req);
  const result = await withTenant(me.orgId, async (tx) => {
    const current = await loadManageable(tx, req);
    if (current.ends_at <= new Date()) throw badRequest('Past bookings cannot be cancelled');
    await tx.updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', current.id)
      .execute();
    return current;
  });

  publishBookingChange({
    type: 'booking.cancelled', orgId: me.orgId, buildingId: result.building_id,
    roomId: result.room_id, bookingId: result.id, organizerId: result.user_id, actorId: me.userId,
  });
  res.status(204).end();
});
