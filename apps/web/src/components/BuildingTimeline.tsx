/**
 * Rooms × hours grid for one building and one day (Robin/Condeco style).
 * Positions are computed on the building's wall clock, so a booking at 10:00
 * Bengaluru time sits at the 10:00 mark for every viewer, whatever their zone.
 */
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { AMENITY_LABELS, type Booking, type BuildingSchedule, type ScheduleRoom } from '@roomly/shared';
import { inZone, fmtRange } from '../lib/time';
import { cx } from './ui';

const SLOT_MINUTES = 30;
const DEFAULT_FIRST_HOUR = 7;
const DEFAULT_LAST_HOUR = 21;

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => DateTime.now());
  useEffect(() => {
    const id = setInterval(() => setNow(DateTime.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function BuildingTimeline({ schedule, rooms, onSlotClick, onBookingClick }: {
  schedule: BuildingSchedule;
  rooms: ScheduleRoom[];
  onSlotClick: (room: ScheduleRoom, start: DateTime) => void;
  onBookingClick: (room: ScheduleRoom, booking: Booking) => void;
}) {
  const tz = schedule.building.timezone;
  const now = useNow().setZone(tz);
  const dayStart = inZone(schedule.dayStart, tz);

  // Show 07:00–21:00, widened to include any booking that falls outside it.
  let firstHour = DEFAULT_FIRST_HOUR;
  let lastHour = DEFAULT_LAST_HOUR;
  for (const b of schedule.bookings) {
    const s = DateTime.max(inZone(b.start, tz), dayStart);
    const e = DateTime.min(inZone(b.end, tz), inZone(schedule.dayEnd, tz));
    firstHour = Math.min(firstHour, s.hour);
    lastHour = Math.max(lastHour, e.hasSame(dayStart, 'day') ? Math.ceil(e.hour + e.minute / 60) : 24);
  }
  const viewStart = dayStart.set({ hour: firstHour });
  const viewEnd = lastHour === 24 ? inZone(schedule.dayEnd, tz) : dayStart.set({ hour: lastHour });
  const totalMs = viewEnd.toMillis() - viewStart.toMillis();
  const pct = (t: DateTime) => ((t.toMillis() - viewStart.toMillis()) / totalMs) * 100;

  const slots: DateTime[] = [];
  for (let t = viewStart; t < viewEnd; t = t.plus({ minutes: SLOT_MINUTES })) slots.push(t);
  const hours = slots.filter((t) => t.minute === 0);
  const showNow = now >= viewStart && now < viewEnd;

  const byRoom = new Map<string, Booking[]>();
  for (const b of schedule.bookings) byRoom.set(b.roomId, [...(byRoom.get(b.roomId) ?? []), b]);

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[56rem]" style={{ gridTemplateColumns: '13rem 1fr' }}>
        {/* Hour ruler */}
        <div className="sticky left-0 z-10 border-b border-slate-200 bg-white" />
        <div className="relative h-8 border-b border-slate-200">
          {hours.map((h, i) => (
            <span
              key={h.toMillis()}
              className={cx('absolute top-2 text-xs text-slate-400', i > 0 && '-translate-x-1/2')}
              style={{ left: `${pct(h)}%` }}
            >
              {h.toFormat('HH:mm')}
            </span>
          ))}
        </div>

        {rooms.map((room) => (
          <Fragment key={room.id}>
            <div className="sticky left-0 z-10 flex flex-col justify-center border-b border-slate-100 bg-white py-2 pr-3">
              <Link to={`/rooms/${room.id}`} className="truncate font-medium text-slate-900 hover:text-indigo-600">{room.name}</Link>
              <div className="truncate text-xs text-slate-500" title={room.amenities.map((a) => AMENITY_LABELS[a]).join(', ')}>
                {room.floorName} · {room.capacity} {room.capacity === 1 ? 'seat' : 'seats'}{room.amenities.length ? ` · ${room.amenities.map((a) => AMENITY_LABELS[a]).join(', ')}` : ''}
              </div>
            </div>
            <div className="relative h-14 border-b border-slate-100">
              {/* Clickable half-hour cells */}
              <div className="absolute inset-0 flex">
                {slots.map((t) => {
                  const past = t.plus({ minutes: SLOT_MINUTES }) <= now;
                  return (
                    <button
                      key={t.toMillis()}
                      type="button"
                      disabled={past}
                      onClick={() => onSlotClick(room, DateTime.max(t, now.startOf('minute').plus({ minutes: 5 - (now.minute % 5) })))}
                      aria-label={`Book ${room.name} at ${t.toFormat('HH:mm')}`}
                      className={cx(
                        'h-full flex-1 border-l',
                        t.minute === 0 ? 'border-slate-200' : 'border-slate-100 border-dashed',
                        past ? 'cursor-default bg-slate-50/80' : 'hover:bg-indigo-50',
                      )}
                    />
                  );
                })}
              </div>
              {/* Bookings */}
              {(byRoom.get(room.id) ?? []).map((b) => {
                const s = DateTime.max(inZone(b.start, tz), viewStart);
                const e = DateTime.min(inZone(b.end, tz), viewEnd);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onBookingClick(room, b)}
                    title={`${b.title} · ${fmtRange(b.start, b.end, tz)} · ${b.organizer.name}`}
                    className={cx(
                      'absolute inset-y-1.5 overflow-hidden rounded-md px-2 text-left text-xs shadow-sm ring-1 transition-shadow hover:shadow-md',
                      b.isMine ? 'bg-indigo-600 text-white ring-indigo-700' : 'bg-slate-200 text-slate-800 ring-slate-300',
                    )}
                    style={{ left: `${pct(s)}%`, width: `calc(${pct(e) - pct(s)}% - 2px)` }}
                  >
                    <div className="truncate font-medium">{b.title}</div>
                    <div className={cx('truncate', b.isMine ? 'text-indigo-100' : 'text-slate-500')}>
                      {fmtRange(b.start, b.end, tz)} · {b.organizer.name}
                    </div>
                  </button>
                );
              })}
              {showNow && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: `${pct(now)}%` }} />}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
