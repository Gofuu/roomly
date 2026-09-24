import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import type { DatesSetArg, EventClickArg } from '@fullcalendar/core';
import type { DateSelectArg } from '@fullcalendar/core';
import { AMENITY_LABELS } from '@roomly/shared';
import { useRoomBookings } from '../lib/queries';
import { isForeignZone, zoneLabel } from '../lib/time';
import { BookingDialog, type BookingDialogState } from '../components/BookingDialog';
import { LiveBadge, Viewers } from '../components/LiveIndicators';
import { useLiveChannel } from '../lib/realtime';
import { Alert, Badge, Card, PageHeader, Spinner, errorMessage } from '../components/ui';

/** One room's week, in the building's time zone. Drag across free time to book. */
export function RoomPage() {
  const { id = '' } = useParams();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [dialog, setDialog] = useState<BookingDialogState>(null);
  const q = useRoomBookings(id, range.from, range.to);
  const viewers = useLiveChannel('room', id);
  const room = q.data?.room;
  const tz = room?.timezone;

  const events = useMemo(() => (q.data?.bookings ?? []).map((b) => ({
    id: b.id,
    title: `${b.title} · ${b.organizer.name}`,
    start: b.start,
    end: b.end,
    backgroundColor: b.isMine ? '#4f46e5' : '#e2e8f0',
    borderColor: b.isMine ? '#4338ca' : '#cbd5e1',
    textColor: b.isMine ? '#ffffff' : '#1e293b',
    extendedProps: { booking: b },
  })), [q.data]);

  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  const dialogRoom = room && { id: room.id, name: room.name, timezone: room.timezone, subtitle: `${room.buildingName} · ${room.floorName}` };

  return (
    <div>
      <div className="mb-2 text-sm"><Link to="/" className="text-indigo-600 hover:underline">← All rooms</Link></div>
      <PageHeader
        title={room?.name ?? 'Room'}
        description={room ? `${room.buildingName} · ${room.floorName} · ${room.capacity} seats${tz && isForeignZone(tz) ? ` · times in ${zoneLabel(tz)}` : ''}` : undefined}
        actions={
          <div className="flex items-center gap-3">
            <Viewers viewers={viewers} />
            {room && !room.isActive ? <Badge tone="amber">Inactive</Badge> : <LiveBadge />}
          </div>
        }
      />
      {room && room.amenities.length > 0 && (
        <div className="-mt-3 mb-5 flex flex-wrap gap-1.5">
          {room.amenities.map((a) => <Badge key={a}>{AMENITY_LABELS[a]}</Badge>)}
        </div>
      )}

      <Card className="p-4">
        {/* The calendar needs the room's zone before it can render; the first fetch uses the viewer's week. */}
        {!tz && range.from && <Spinner />}
        <div className={!tz && range.from ? 'hidden' : ''}>
          <FullCalendar
            key={tz ?? 'local'}
            plugins={[timeGridPlugin, interactionPlugin, luxonPlugin]}
            initialView="timeGridWeek"
            timeZone={tz ?? 'local'}
            firstDay={1}
            allDaySlot={false}
            nowIndicator
            height="auto"
            slotMinTime="07:00:00"
            slotMaxTime="21:00:00"
            slotDuration="00:30:00"
            snapDuration="00:15:00"
            eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek' }}
            selectable={!!room?.isActive}
            selectMirror
            selectAllow={(sel) => sel.start.getTime() > Date.now() - 5 * 60_000}
            events={events}
            datesSet={(arg: DatesSetArg) => {
              const next = { from: arg.start.toISOString(), to: arg.end.toISOString() };
              if (next.from !== range.from || next.to !== range.to) setRange(next);
            }}
            select={(sel: DateSelectArg) => {
              sel.view.calendar.unselect();
              if (dialogRoom) setDialog({ mode: 'create', room: dialogRoom, start: sel.start.toISOString(), end: sel.end.toISOString() });
            }}
            eventClick={(arg: EventClickArg) => {
              if (dialogRoom) setDialog({ mode: 'edit', room: dialogRoom, booking: arg.event.extendedProps.booking });
            }}
          />
        </div>
      </Card>

      <BookingDialog state={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
