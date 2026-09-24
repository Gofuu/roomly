import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AMENITIES, AMENITY_LABELS, type Amenity } from '@roomly/shared';
import { useSession } from '../lib/auth';
import { useBuildingSchedule, useSpaces } from '../lib/queries';
import { addDays, fmtLongDate, isForeignZone, todayIn, zoneLabel } from '../lib/time';
import { BuildingTimeline } from '../components/BuildingTimeline';
import { BookingDialog, type BookingDialogState } from '../components/BookingDialog';
import { LiveBadge, Viewers } from '../components/LiveIndicators';
import { useLiveChannel } from '../lib/realtime';
import { Alert, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, cx, errorMessage } from '../components/ui';

const SEAT_FILTERS = [0, 2, 4, 8, 12];

export function HomePage() {
  const { user } = useSession();
  const spaces = useSpaces();
  const [params, setParams] = useSearchParams();

  const buildings = spaces.data ?? [];
  const building = buildings.find((b) => b.id === params.get('building')) ?? buildings[0];
  const tz = building?.timezone ?? 'UTC';
  const date = params.get('date') ?? todayIn(tz);
  const minSeats = Number(params.get('seats') ?? 0);
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [dialog, setDialog] = useState<BookingDialogState>(null);

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v === null ? p.delete(k) : p.set(k, v);
    setParams(p, { replace: true });
  };

  // Changing building resets the date to "today" there (it may be a different day).
  useEffect(() => {
    if (building && !params.get('date')) update({ date: todayIn(building.timezone) });
  }, [building?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useBuildingSchedule(building?.id, date);
  const viewers = useLiveChannel('building', building?.id);
  const rooms = useMemo(
    () => (schedule.data?.rooms ?? []).filter(
      (r) => r.capacity >= minSeats && amenities.every((a) => r.amenities.includes(a)),
    ),
    [schedule.data, minSeats, amenities],
  );

  if (spaces.isPending) return <Spinner />;
  if (spaces.isError) return <Alert>{errorMessage(spaces.error)}</Alert>;
  if (!building) {
    return (
      <EmptyState
        title="No rooms to book yet"
        description={user.role === 'admin' ? 'Add a building, floor and rooms to get started.' : 'Your admin has not set up any rooms yet.'}
        action={user.role === 'admin' && <Link to="/admin/spaces"><Button>Set up spaces</Button></Link>}
      />
    );
  }

  const today = todayIn(tz);
  const subtitle = (room: { floorName: string; capacity: number }) => `${building.name} · ${room.floorName} · ${room.capacity} seats`;

  return (
    <div>
      <PageHeader
        title="Book a room"
        description={`Click a free slot to book it. Times are shown in ${building.name}'s local time${isForeignZone(tz) ? ` (${zoneLabel(tz)})` : ''}.`}
        actions={<div className="flex items-center gap-3"><Viewers viewers={viewers} /><LiveBadge /></div>}
      />

      <Card className="mb-4 flex flex-wrap items-center gap-3 px-4 py-3">
        {buildings.length > 1 && (
          <div className="w-52">
            <Select value={building.id} onChange={(e) => update({ building: e.target.value, date: null })}>
              {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button variant="secondary" aria-label="Previous day" onClick={() => update({ date: addDays(date, -1) })}>‹</Button>
          <Button variant="secondary" disabled={date === today} onClick={() => update({ date: today })}>Today</Button>
          <Button variant="secondary" aria-label="Next day" onClick={() => update({ date: addDays(date, 1) })}>›</Button>
        </div>
        <div className="w-40"><Input type="date" value={date} onChange={(e) => e.target.value && update({ date: e.target.value })} /></div>
        <span className="font-medium text-slate-700">{fmtLongDate(date)}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-32">
            <Select value={minSeats} onChange={(e) => update({ seats: e.target.value === '0' ? null : e.target.value })}>
              {SEAT_FILTERS.map((n) => <option key={n} value={n}>{n ? `${n}+ seats` : 'Any size'}</option>)}
            </Select>
          </div>
          {AMENITIES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAmenities(amenities.includes(a) ? amenities.filter((x) => x !== a) : [...amenities, a])}
              className={cx('rounded-full px-2.5 py-1 text-xs ring-1',
                amenities.includes(a) ? 'bg-indigo-600 text-white ring-indigo-600' : 'text-slate-600 ring-slate-300 hover:bg-slate-50')}
            >
              {AMENITY_LABELS[a]}
            </button>
          ))}
        </div>
      </Card>

      <Card className="px-4 py-2">
        {schedule.isPending ? <div className="p-6"><Spinner /></div>
          : schedule.isError ? <div className="p-4"><Alert>{errorMessage(schedule.error)}</Alert></div>
          : rooms.length === 0 ? <p className="p-6 text-sm text-slate-500">No rooms match these filters.</p>
          : (
            <BuildingTimeline
              schedule={schedule.data}
              rooms={rooms}
              onSlotClick={(room, start) => setDialog({
                mode: 'create',
                room: { id: room.id, name: room.name, timezone: tz, subtitle: subtitle(room) },
                start: start.toISO()!,
                end: start.plus({ minutes: 30 }).toISO()!,
              })}
              onBookingClick={(room, booking) => setDialog({
                mode: 'edit', room: { id: room.id, name: room.name, timezone: tz, subtitle: subtitle(room) }, booking,
              })}
            />
          )}
      </Card>

      <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="size-3 rounded bg-indigo-600" /> Your bookings</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded bg-slate-200 ring-1 ring-slate-300" /> Booked by others</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-red-500" /> Now</span>
      </div>

      <BookingDialog state={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
