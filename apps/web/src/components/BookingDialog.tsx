import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Booking, BookingConflictDetails } from '@roomly/shared';
import { ApiError, api } from '../lib/api';
import { keys } from '../lib/queries';
import { fmtRange, inZone, isForeignZone, localToIso, timeOptions, zoneLabel } from '../lib/time';
import { Modal } from './Modal';
import { Alert, Button, Field, Input, Select, errorMessage } from './ui';

export interface DialogRoom {
  id: string;
  name: string;
  timezone: string;
  subtitle?: string;
}

export type BookingDialogState =
  | { mode: 'create'; room: DialogRoom; start: string; end: string }
  | { mode: 'edit'; room: DialogRoom; booking: Booking }
  | null;

const TIMES = timeOptions(15);

export function BookingDialog({ state, onClose }: { state: BookingDialogState; onClose: () => void }) {
  const qc = useQueryClient();
  const tz = state?.room.timezone ?? 'UTC';
  const initial = state?.mode === 'edit' ? state.booking : state;

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [error, setError] = useState<string>();
  const [conflicts, setConflicts] = useState<BookingConflictDetails['conflicts']>([]);
  const [busy, setBusy] = useState<'save' | 'cancel' | null>(null);

  useEffect(() => {
    if (!state || !initial) return;
    const s = inZone(initial.start, tz);
    const e = inZone(initial.end, tz);
    setTitle(state.mode === 'edit' ? state.booking.title : '');
    setDate(s.toISODate()!);
    setStartTime(s.toFormat('HH:mm'));
    setEndTime(e.toFormat('HH:mm'));
    setError(undefined);
    setConflicts([]);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = state?.mode === 'edit' && !state.booking.canManage;
  const finish = async () => {
    await qc.invalidateQueries({ queryKey: keys.bookings });
    onClose();
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!state) return;
    setBusy('save');
    setError(undefined);
    setConflicts([]);
    // An end of 00:00 means midnight at the end of the chosen day.
    const endDate = endTime <= startTime ? inZone(localToIso(date, '00:00', tz), tz).plus({ days: 1 }).toISODate()! : date;
    const body = { title, start: localToIso(date, startTime, tz), end: localToIso(endDate, endTime, tz) };
    try {
      if (state.mode === 'create') await api.post('/bookings', { ...body, roomId: state.room.id });
      else await api.patch(`/bookings/${state.booking.id}`, body);
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BOOKING_CONFLICT') {
        setConflicts((err.details as BookingConflictDetails).conflicts);
        setError('Someone else has this room for part of that time.');
      } else {
        setError(errorMessage(err));
      }
      // Whatever went wrong, the calendar behind the dialog may be stale.
      qc.invalidateQueries({ queryKey: keys.bookings });
    } finally {
      setBusy(null);
    }
  }

  async function cancelBooking() {
    if (state?.mode !== 'edit' || !confirm('Cancel this booking?')) return;
    setBusy('cancel');
    try {
      await api.delete(`/bookings/${state.booking.id}`);
      await finish();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const title_ = state?.mode === 'edit' ? (readOnly ? 'Booking details' : 'Edit booking') : 'Book room';

  return (
    <Modal open={state !== null} onClose={onClose} title={title_}>
      {state && (
        <form onSubmit={save} className="space-y-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2.5">
            <div className="font-medium text-slate-900">{state.room.name}</div>
            {state.room.subtitle && <div className="text-xs text-slate-500">{state.room.subtitle}</div>}
            {state.mode === 'edit' && <div className="mt-1 text-xs text-slate-500">Organized by {state.booking.organizer.name}</div>}
          </div>

          {error && (
            <Alert>
              {error}
              {conflicts.length > 0 && (
                <ul className="mt-1.5 list-inside list-disc text-xs">
                  {conflicts.map((c) => (
                    <li key={c.start}>{fmtRange(c.start, c.end, tz)}: {c.title} ({c.organizerName})</li>
                  ))}
                </ul>
              )}
            </Alert>
          )}

          <Field label="Title">
            <Input required autoFocus={!readOnly} disabled={readOnly} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Team sync" maxLength={200} />
          </Field>
          <Field label="Date">
            <Input type="date" required disabled={readOnly} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <Select disabled={readOnly} value={startTime} onChange={(e) => setStartTime(e.target.value)}>
                {withValue(TIMES, startTime).map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="End">
              <Select disabled={readOnly} value={endTime} onChange={(e) => setEndTime(e.target.value)}>
                {withValue(TIMES, endTime).map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
          </div>
          {isForeignZone(tz) && (
            <p className="text-xs text-amber-700">Times are in the building's time zone ({tz}, {zoneLabel(tz)}).</p>
          )}

          {!readOnly && (
            <div className="flex items-center justify-between gap-2 pt-2">
              {state.mode === 'edit'
                ? <Button type="button" variant="danger" loading={busy === 'cancel'} onClick={cancelBooking}>Cancel booking</Button>
                : <span />}
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
                <Button type="submit" loading={busy === 'save'}>{state.mode === 'create' ? 'Book' : 'Save'}</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

/** Keeps an off-grid value (e.g. 10:05 from an API booking) selectable. */
function withValue(options: string[], value: string) {
  return value && !options.includes(value) ? [...options, value].sort() : options;
}
