import { Router } from 'express';
import {
  buildingInputSchema, floorInputSchema, roomInputSchema, roomUpdateSchema,
  type Amenity, type Building, type Floor, type Room,
} from '@roomly/shared';
import { withTenant, type Tx } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { conflict, notFound, pgErrorCode } from '../http/errors.js';
import { param, validateIdParams } from '../http/params.js';
import { assertCanAddActiveRoom, getPlanUsage } from './plan-limits.js';

export const spacesRouter = Router();

type RoomRow = { id: string; floor_id: string; name: string; capacity: number; amenities: string[]; is_active: boolean };
const toRoom = (r: RoomRow): Room => ({
  id: r.id, floorId: r.floor_id, name: r.name, capacity: r.capacity, amenities: r.amenities as Amenity[], isActive: r.is_active,
});
const ROOM_COLUMNS = ['id', 'floor_id', 'name', 'capacity', 'amenities', 'is_active'] as const;

/** Buildings → floors → rooms for the caller's org. Employees only see active rooms. */
export async function loadSpaceTree(tx: Tx, includeInactive: boolean): Promise<Building[]> {
  const [buildings, floors, rooms] = await Promise.all([
    tx.selectFrom('buildings').select(['id', 'name', 'address', 'timezone']).orderBy('name').execute(),
    tx.selectFrom('floors').select(['id', 'building_id', 'name', 'level']).orderBy('level').execute(),
    tx.selectFrom('rooms').select(ROOM_COLUMNS)
      .$if(!includeInactive, (q) => q.where('is_active', '=', true))
      .orderBy('name').execute(),
  ]);
  const floorMap = new Map<string, Floor>(
    floors.map((f) => [f.id, { id: f.id, buildingId: f.building_id, name: f.name, level: f.level, rooms: [] }]),
  );
  for (const r of rooms) floorMap.get(r.floor_id)?.rooms.push(toRoom(r));
  return buildings.map((b) => ({
    ...b,
    floors: [...floorMap.values()].filter((f) => f.buildingId === b.id),
  }));
}

/** Deleting something that bookings still reference fails the FK; explain what to do instead. */
function rethrowIfReferencedByBookings(err: unknown, what: string): never {
  if (pgErrorCode(err) === '23503') {
    throw conflict('HAS_BOOKINGS', `This ${what} has booking history, so it can't be deleted. Deactivate its rooms instead.`);
  }
  throw err;
}

spacesRouter.get('/spaces', async (req, res) => {
  const { orgId, role } = auth(req);
  res.json(await withTenant(orgId, (tx) => loadSpaceTree(tx, role === 'admin')));
});

spacesRouter.get('/plan-usage', async (req, res) => {
  const { orgId } = auth(req);
  res.json(await withTenant(orgId, (tx) => getPlanUsage(tx, orgId)));
});

// ---------------------------------------------------------------------------
// Admin-only mutations
// ---------------------------------------------------------------------------
// requireAdmin is attached per route, not with admin.use(): this router is
// mounted at /api, so router-level middleware would run for every later route.
const admin = Router();
validateIdParams(admin, 'id');
spacesRouter.use(admin);

admin.post('/buildings', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const input = buildingInputSchema.parse(req.body);
  const row = await withTenant(orgId, (tx) =>
    tx.insertInto('buildings').values({ ...input, org_id: orgId })
      .returning(['id', 'name', 'address', 'timezone']).executeTakeFirstOrThrow(),
  ).catch((err) => {
    if (pgErrorCode(err) === '23505') throw conflict('NAME_TAKEN', 'A building with that name already exists');
    throw err;
  });
  res.status(201).json({ ...row, floors: [] } satisfies Building);
});

admin.patch('/buildings/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const input = buildingInputSchema.partial().parse(req.body);
  const row = await withTenant(orgId, (tx) =>
    tx.updateTable('buildings').set(input).where('id', '=', param(req, 'id'))
      .returning(['id', 'name', 'address', 'timezone']).executeTakeFirst(),
  );
  if (!row) throw notFound('Building');
  res.json(row);
});

admin.delete('/buildings/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const result = await withTenant(orgId, (tx) =>
    tx.deleteFrom('buildings').where('id', '=', param(req, 'id')).executeTakeFirst(),
  ).catch((err) => rethrowIfReferencedByBookings(err, 'building'));
  if (!result.numDeletedRows) throw notFound('Building');
  res.status(204).end();
});

admin.post('/buildings/:id/floors', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const input = floorInputSchema.parse(req.body);
  const row = await withTenant(orgId, (tx) =>
    // The composite FK (building_id, org_id) makes another org's building id fail with 23503.
    tx.insertInto('floors').values({ ...input, building_id: param(req, 'id'), org_id: orgId })
      .returning(['id', 'building_id', 'name', 'level']).executeTakeFirstOrThrow(),
  ).catch((err) => {
    if (pgErrorCode(err) === '23503') throw notFound('Building');
    if (pgErrorCode(err) === '23505') throw conflict('LEVEL_TAKEN', 'That building already has a floor at this level');
    throw err;
  });
  res.status(201).json({ id: row.id, buildingId: row.building_id, name: row.name, level: row.level, rooms: [] } satisfies Floor);
});

admin.patch('/floors/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const input = floorInputSchema.partial().parse(req.body);
  const row = await withTenant(orgId, (tx) =>
    tx.updateTable('floors').set(input).where('id', '=', param(req, 'id'))
      .returning(['id', 'building_id', 'name', 'level']).executeTakeFirst(),
  ).catch((err) => {
    if (pgErrorCode(err) === '23505') throw conflict('LEVEL_TAKEN', 'That building already has a floor at this level');
    throw err;
  });
  if (!row) throw notFound('Floor');
  res.json({ id: row.id, buildingId: row.building_id, name: row.name, level: row.level });
});

admin.delete('/floors/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const result = await withTenant(orgId, (tx) => tx.deleteFrom('floors').where('id', '=', param(req, 'id')).executeTakeFirst())
    .catch((err) => rethrowIfReferencedByBookings(err, 'floor'));
  if (!result.numDeletedRows) throw notFound('Floor');
  res.status(204).end();
});

admin.post('/floors/:id/rooms', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const input = roomInputSchema.parse(req.body);
  const row = await withTenant(orgId, async (tx) => {
    await assertCanAddActiveRoom(tx, orgId);
    return tx.insertInto('rooms').values({ ...input, floor_id: param(req, 'id'), org_id: orgId })
      .returning(ROOM_COLUMNS).executeTakeFirstOrThrow();
  }).catch((err) => {
    if (pgErrorCode(err) === '23503') throw notFound('Floor');
    if (pgErrorCode(err) === '23505') throw conflict('NAME_TAKEN', 'A room with that name already exists on this floor');
    throw err;
  });
  res.status(201).json(toRoom(row));
});

admin.patch('/rooms/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const { isActive, ...rest } = roomUpdateSchema.parse(req.body);
  const row = await withTenant(orgId, async (tx) => {
    if (isActive === true) {
      const current = await tx.selectFrom('rooms').select('is_active').where('id', '=', param(req, 'id')).executeTakeFirst();
      if (current && !current.is_active) await assertCanAddActiveRoom(tx, orgId); // reactivation counts as adding
    }
    return tx.updateTable('rooms')
      .set({ ...rest, ...(isActive === undefined ? {} : { is_active: isActive }) })
      .where('id', '=', param(req, 'id'))
      .returning(ROOM_COLUMNS)
      .executeTakeFirst();
  }).catch((err) => {
    if (pgErrorCode(err) === '23505') throw conflict('NAME_TAKEN', 'A room with that name already exists on this floor');
    throw err;
  });
  if (!row) throw notFound('Room');
  res.json(toRoom(row));
});

admin.delete('/rooms/:id', requireAdmin, async (req, res) => {
  const { orgId } = auth(req);
  const result = await withTenant(orgId, (tx) => tx.deleteFrom('rooms').where('id', '=', param(req, 'id')).executeTakeFirst())
    .catch((err) => rethrowIfReferencedByBookings(err, 'room'));
  if (!result.numDeletedRows) throw notFound('Room');
  res.status(204).end();
});
