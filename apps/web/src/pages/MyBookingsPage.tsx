import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MyBooking } from '@roomly/shared';
import { useMyBookings } from '../lib/queries';
import { fmtDay, fmtRange, inZone, isForeignZone, zoneLabel } from '../lib/time';
import { BookingDialog, type BookingDialogState } from '../components/BookingDialog';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, cx, errorMessage } from '../components/ui';

export function MyBookingsPage() {
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const q = useMyBookings(when);
  const [dialog, setDialog] = useState<BookingDialogState>(null);

  // Group by local day in each booking's own building.
  const groups: { day: string; items: MyBooking[] }[] = [];
  for (const b of q.data ?? []) {
    const day = fmtDay(b.start, b.timezone);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(b);
    else groups.push({ day, items: [b] });
  }

  return (
    <div>
      <PageHeader title="My bookings" />
      <div className="mb-4 inline-flex rounded-lg bg-slate-100 p-1">
        {(['upcoming', 'past'] as const).map((w) => (
          <button
            key={w}
            onClick={() => setWhen(w)}
            className={cx('rounded-md px-3 py-1 text-sm font-medium',
              when === w ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}
          >
            {w === 'past' ? 'Past & cancelled' : 'Upcoming'}
          </button>
        ))}
      </div>

      {q.isPending ? <Spinner /> : q.isError ? <Alert>{errorMessage(q.error)}</Alert> : groups.length === 0 ? (
        <EmptyState
          title={when === 'upcoming' ? 'No upcoming bookings' : 'Nothing here yet'}
          action={when === 'upcoming' && <Link to="/" className="text-sm font-medium text-indigo-600">Book a room →</Link>}
        />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.day}>
              <h2 className="mb-2 text-sm font-semibold text-slate-500">{g.day}</h2>
              <Card>
                <ul className="divide-y divide-slate-100">
                  {g.items.map((b) => {
                    const live = b.status === 'confirmed' && inZone(b.end, b.timezone).toMillis() > Date.now();
                    return (
                      <li key={b.id}>
                        <button
                          type="button"
                          disabled={!live}
                          onClick={() => setDialog({
                            mode: 'edit',
                            booking: b,
                            room: { id: b.roomId, name: b.roomName, timezone: b.timezone, subtitle: b.buildingName },
                          })}
                          className="flex w-full items-center gap-4 px-5 py-3 text-left enabled:hover:bg-slate-50"
                        >
                          <div className="w-32 shrink-0 text-sm font-medium text-slate-900">
                            {fmtRange(b.start, b.end, b.timezone)}
                            {isForeignZone(b.timezone) && <div className="text-xs font-normal text-slate-400">{zoneLabel(b.timezone)}</div>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className={cx('truncate font-medium', b.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-900')}>{b.title}</div>
                            <div className="truncate text-sm text-slate-500">{b.roomName} · {b.buildingName}</div>
                          </div>
                          {b.status === 'cancelled' && <Badge tone="red">Cancelled</Badge>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      <BookingDialog state={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
