import { Router } from 'express';
import { sql } from 'kysely';
import { memberUpdateSchema, type Member } from '@roomly/shared';
import { withDb, withTenant } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { HttpError, notFound } from '../http/errors.js';
import { validateIdParams } from '../http/params.js';

/**
 * Admin-only team management. Mounted behind requireAuth.
 * users is not covered by row-level security, so every query filters by org_id.
 */
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
  const rows = await withDb((tx) =>
    tx.selectFrom('users').select(COLUMNS).where('org_id', '=', orgId)
      .orderBy('is_active', 'desc').orderBy('name').execute(),
  );
  res.json(rows.map(toMember));
});

/**
 * Changes a member's name, role or active flag.
 *
 * A company must always keep at least one active admin. Two admins demoting
 * each other at the same moment would both pass a simple "count the admins"
 * check, so the organization row is locked first: the second request waits,
 * then counts again and sees the first one's change.
 */
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
      .where('org_id', '=', orgId)
      .where('id', '=', req.params.id)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!updated) return undefined;

    const { n } = await tx.selectFrom('users')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('org_id', '=', orgId).where('role', '=', 'admin').where('is_active', '=', true)
      .executeTakeFirstOrThrow();
    if (n === 0) throw new HttpError(409, 'LAST_ADMIN', 'Your organization needs at least one active admin');

    if (input.isActive === false) {
      // Sign them out, and release the rooms they had booked for the future.
      await tx.deleteFrom('refresh_tokens').where('user_id', '=', updated.id).execute();
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
  res.json(toMember(row));
});
