import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AMENITIES, AMENITY_LABELS, type Amenity, type Building, type Floor, type Room } from '@roomly/shared';
import { api, ApiError } from '../../lib/api';
import { keys, usePlanUsage, useSpaces } from '../../lib/queries';
import { Modal } from '../../components/Modal';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, cx, errorMessage } from '../../components/ui';

type Dialog =
  | { kind: 'building'; building?: Building }
  | { kind: 'floor'; buildingId: string; floor?: Floor }
  | { kind: 'room'; floorId: string; room?: Room }
  | null;

const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');

export function SpacesPage() {
  const spaces = useSpaces();
  const usage = usePlanUsage();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [actionError, setActionError] = useState<string>();
  const qc = useQueryClient();

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: keys.spaces }),
    qc.invalidateQueries({ queryKey: keys.planUsage }),
  ]);

  const mutate = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: invalidate,
    onError: (err) => setActionError(errorMessage(err)),
  });
  const run = (fn: () => Promise<unknown>) => { setActionError(undefined); mutate.mutate(fn); };

  const atLimit = usage.data && usage.data.roomLimit !== null && usage.data.activeRooms >= usage.data.roomLimit;

  return (
    <div>
      <PageHeader
        title="Spaces"
        description="Buildings, floors and the rooms people can book."
        actions={<Button onClick={() => setDialog({ kind: 'building' })}>Add building</Button>}
      />

      {usage.data && (
        <Card className="mb-6 flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-48 flex-1">
            <div className="flex justify-between text-sm">
              <span className="font-medium text-slate-700">Active rooms</span>
              <span className="text-slate-500">
                {usage.data.activeRooms} of {usage.data.roomLimit ?? 'unlimited'} on the {usage.data.planName} plan
              </span>
            </div>
            {usage.data.roomLimit !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cx('h-full rounded-full', atLimit ? 'bg-amber-500' : 'bg-indigo-600')}
                  style={{ width: `${Math.min(100, (usage.data.activeRooms / Math.max(1, usage.data.roomLimit)) * 100)}%` }}
                />
              </div>
            )}
          </div>
          {atLimit && <Link to="/admin/billing"><Button variant="secondary">Upgrade plan</Button></Link>}
        </Card>
      )}

      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}

      {spaces.isPending ? <Spinner /> : spaces.isError ? <Alert>{errorMessage(spaces.error)}</Alert> : spaces.data.length === 0 ? (
        <EmptyState
          title="No buildings yet"
          description="Add your first office building, then its floors and rooms."
          action={<Button onClick={() => setDialog({ kind: 'building' })}>Add building</Button>}
        />
      ) : (
        <div className="space-y-6">
          {spaces.data.map((b) => (
            <Card key={b.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div>
                  <h2 className="font-semibold text-slate-900">{b.name}</h2>
                  <p className="text-sm text-slate-500">{[b.address, b.timezone].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setDialog({ kind: 'floor', buildingId: b.id })}>Add floor</Button>
                  <Button variant="ghost" onClick={() => setDialog({ kind: 'building', building: b })}>Edit</Button>
                  <Button variant="ghost" className="text-red-600" onClick={() => {
                    if (confirm(`Delete ${b.name} and all its floors and rooms?`)) run(() => api.delete(`/buildings/${b.id}`));
                  }}>Delete</Button>
                </div>
              </div>
              {b.floors.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">No floors yet.</p>
              ) : b.floors.map((f) => (
                <div key={f.id} className="border-b border-slate-100 px-5 py-4 last:border-0">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-slate-700">
                      {f.name} <span className="font-normal text-slate-400">· level {f.level}</span>
                    </h3>
                    <div className="flex gap-1">
                      <Button variant="ghost" className="text-xs" onClick={() => setDialog({ kind: 'room', floorId: f.id })}>Add room</Button>
                      <Button variant="ghost" className="text-xs" onClick={() => setDialog({ kind: 'floor', buildingId: b.id, floor: f })}>Edit</Button>
                      <Button variant="ghost" className="text-xs text-red-600" onClick={() => {
                        if (confirm(`Delete ${f.name} and its rooms?`)) run(() => api.delete(`/floors/${f.id}`));
                      }}>Delete</Button>
                    </div>
                  </div>
                  {f.rooms.length === 0 ? <p className="text-sm text-slate-400">No rooms on this floor.</p> : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {f.rooms.map((r) => (
                        <div key={r.id} className={cx('rounded-lg p-3 ring-1', r.isActive ? 'ring-slate-200' : 'bg-slate-50 ring-slate-200/60')}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className={cx('font-medium', r.isActive ? 'text-slate-900' : 'text-slate-400')}>{r.name}</div>
                              <div className="text-xs text-slate-500">Seats {r.capacity}</div>
                            </div>
                            {r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
                          </div>
                          {r.amenities.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {r.amenities.map((a) => <Badge key={a} tone="slate">{AMENITY_LABELS[a]}</Badge>)}
                            </div>
                          )}
                          <div className="mt-2 flex gap-3 text-xs">
                            <button className="text-indigo-600 hover:underline" onClick={() => setDialog({ kind: 'room', floorId: f.id, room: r })}>Edit</button>
                            <button className="text-slate-600 hover:underline" onClick={() => run(() => api.patch(`/rooms/${r.id}`, { isActive: !r.isActive }))}>
                              {r.isActive ? 'Deactivate' : 'Activate'}
                            </button>
                            <button className="text-red-600 hover:underline" onClick={() => {
                              if (confirm(`Delete ${r.name}?`)) run(() => api.delete(`/rooms/${r.id}`));
                            }}>Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}

      <SpaceDialog dialog={dialog} onClose={() => setDialog(null)} onSaved={invalidate} />
    </div>
  );
}

function SpaceDialog({ dialog, onClose, onSaved }: { dialog: Dialog; onClose: () => void; onSaved: () => Promise<unknown> }) {
  return (
    <Modal
      open={dialog !== null}
      onClose={onClose}
      title={!dialog ? '' : `${(dialog.kind === 'building' ? dialog.building : dialog.kind === 'floor' ? dialog.floor : dialog.room) ? 'Edit' : 'Add'} ${dialog.kind}`}
    >
      {dialog?.kind === 'building' && <BuildingForm building={dialog.building} onDone={async () => { await onSaved(); onClose(); }} />}
      {dialog?.kind === 'floor' && <FloorForm buildingId={dialog.buildingId} floor={dialog.floor} onDone={async () => { await onSaved(); onClose(); }} />}
      {dialog?.kind === 'room' && <RoomForm floorId={dialog.floorId} room={dialog.room} onDone={async () => { await onSaved(); onClose(); }} />}
    </Modal>
  );
}

function useSubmit(onDone: () => Promise<void>) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = (fn: () => Promise<unknown>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'PLAN_LIMIT_REACHED'
        ? `${err.message}` : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function BuildingForm({ building, onDone }: { building?: Building; onDone: () => Promise<void> }) {
  const [name, setName] = useState(building?.name ?? '');
  const [address, setAddress] = useState(building?.address ?? '');
  const [timezone, setTimezone] = useState(building?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const { error, busy, submit } = useSubmit(onDone);
  const body = { name, address, timezone };
  return (
    <form className="space-y-4" onSubmit={submit(() => building ? api.patch(`/buildings/${building.id}`, body) : api.post('/buildings', body))}>
      {error && <Alert>{error}</Alert>}
      <Field label="Name"><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Bengaluru HQ" /></Field>
      <Field label="Address"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      <Field label="Time zone" hint="Bookings in this building are shown in its local time.">
        <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {TIME_ZONES.map((tz) => <option key={tz}>{tz}</option>)}
        </Select>
      </Field>
      <div className="flex justify-end"><Button type="submit" loading={busy}>Save</Button></div>
    </form>
  );
}

function FloorForm({ buildingId, floor, onDone }: { buildingId: string; floor?: Floor; onDone: () => Promise<void> }) {
  const [name, setName] = useState(floor?.name ?? '');
  const [level, setLevel] = useState(String(floor?.level ?? 0));
  const { error, busy, submit } = useSubmit(onDone);
  const body = { name, level: Number(level) };
  return (
    <form className="space-y-4" onSubmit={submit(() => floor ? api.patch(`/floors/${floor.id}`, body) : api.post(`/buildings/${buildingId}/floors`, body))}>
      {error && <Alert>{error}</Alert>}
      <Field label="Name"><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="3rd Floor" /></Field>
      <Field label="Level" hint="Used for ordering. 0 is ground, negative is basement.">
        <Input type="number" required value={level} onChange={(e) => setLevel(e.target.value)} />
      </Field>
      <div className="flex justify-end"><Button type="submit" loading={busy}>Save</Button></div>
    </form>
  );
}

function RoomForm({ floorId, room, onDone }: { floorId: string; room?: Room; onDone: () => Promise<void> }) {
  const [name, setName] = useState(room?.name ?? '');
  const [capacity, setCapacity] = useState(String(room?.capacity ?? 6));
  const [amenities, setAmenities] = useState<Amenity[]>(room?.amenities ?? []);
  const { error, busy, submit } = useSubmit(onDone);
  const body = { name, capacity: Number(capacity), amenities };
  const toggle = (a: Amenity) => setAmenities(amenities.includes(a) ? amenities.filter((x) => x !== a) : [...amenities, a]);
  return (
    <form className="space-y-4" onSubmit={submit(() => room ? api.patch(`/rooms/${room.id}`, body) : api.post(`/floors/${floorId}/rooms`, body))}>
      {error && <Alert tone={error.includes('plan') ? 'warning' : 'error'}>{error}</Alert>}
      <Field label="Name"><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nilgiri" /></Field>
      <Field label="Seats"><Input type="number" min={1} max={500} required value={capacity} onChange={(e) => setCapacity(e.target.value)} /></Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Amenities</legend>
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((a) => (
            <button
              type="button"
              key={a}
              onClick={() => toggle(a)}
              className={cx('rounded-full px-3 py-1 text-xs ring-1 transition-colors',
                amenities.includes(a) ? 'bg-indigo-600 text-white ring-indigo-600' : 'text-slate-600 ring-slate-300 hover:bg-slate-50')}
            >
              {AMENITY_LABELS[a]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end"><Button type="submit" loading={busy}>Save</Button></div>
    </form>
  );
}
