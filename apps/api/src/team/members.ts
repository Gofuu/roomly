import { Router } from 'express';
import { sql } from 'kysely';
import { memberUpdateSchema, type Member } from '@roomly/shared';
import { withSystem, withTenant, type Tx } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { revokeAllSessions } from '../auth/service.js';
import { HttpError, notFound } from '../http/errors.js';
import { validateIdParams } from '../http/params.js';

/** Admin-only team management. Mounted behind requireAuth. */
export const membersRouter = Router();
membersRouter.use(requireAdmin);
validateIdParams(membersRouter, 'id');

const COLUMNS = ['id', 'email', 'name', 'role', 'is_active', 'created_at'] as const;
type Row = { id: string; email: string; name: string; role: 'admin' | 'employee'; is_active: boolean; created_at: Date };
const toMember = (r: Row): Member => ({
  id: r.id, email: r.email, name: r.name, role: r.role, isActive: r.is_active, createdAt: r.created_at.toISOString(),
});

membersRouter.get('/', async (req, res) => {
  const { orgId } = auth(req);
  const rows = await withTenant(orgId, (tx) =>
    tx.selectFrom('users').select(COLUMNS).orderBy('is_active', 'desc').orderBy('name').execute(),
  );
  res.json(rows.map(toMember));
});

/**
 * Every org must keep at least one active admin, or nobody could manage it.
 * Like the room cap, this is a count across rows that a constraint cannot
 * express, and two admins demoting each other at the same moment would both
 * pass a naive check. So: lock the org row, apply the change, re-count, and
 * roll back if the org would be left without an admin.
 */
async function assertStillHasAdmin(tx: Tx) {
  const { n } = await tx.selectFrom('users')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('role', '=', 'admin').where('is_active', '=', true)
    .executeTakeFirstOrThrow();
  if (n === 0) {
    throw new HttpError(409, 'LAST_ADMIN', 'Your organization needs at least one active admin');
  }
}

membersRouter.patch('/:id', async (req, res) => {
  const { orgId } = auth(req);
  const input = memberUpdateSchema.parse(req.body);

  const row = await withTenant(orgId, async (tx) => {
    await tx.selectFrom('organizations').select('id').where('id', '=', orgId).forUpdate().execute();
    const updated = await tx.updateTable('users')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.isActive !== undefined && { is_active: input.isActive }),
      })
      .where('id', '=', req.params.id)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!updated) return undefined;
    await assertStillHasAdmin(tx);

    if (input.isActive === false) {
      // A deactivated person's upcoming meetings would otherwise hold rooms forever.
      await tx.updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: sql`now()`, updated_at: sql`now()` })
        .where('user_id', '=', updated.id)
        .where('status', '=', 'confirmed')
        .where(sql<boolean>`lower(during) > now()`)
        .execute();
    }
    return updated;
  });
  if (!row) throw notFound('Member');

  // Sign them out everywhere. (Refresh already refuses inactive users; this also
  // clears their tokens. Their current access token lapses within 15 minutes.)
  if (input.isActive === false) await withSystem((tx) => revokeAllSessions(tx, row.id));
  res.json(toMember(row));
});
