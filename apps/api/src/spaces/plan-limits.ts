/**
 * The plan's room limit.
 *
 * "Count the active rooms, compare with the limit, then insert" is the same
 * check-then-act race as naive double-booking: two admins adding a room at once
 * both see 2 of 3 and both insert, leaving 4. A count across rows cannot be
 * written as a constraint, so the organization row is locked first with
 * SELECT ... FOR UPDATE. The second admin's transaction waits at that lock,
 * then counts again and sees the first admin's room.
 */
import type { PlanUsage } from '@roomly/shared';
import { sql } from 'kysely';
import type { Tx } from '../db/index.js';
import { HttpError } from '../http/errors.js';

async function usage(tx: Tx, orgId: string, lock: boolean): Promise<PlanUsage> {
  let q = tx
    .selectFrom('organizations as o')
    .innerJoin('plans as p', 'p.id', 'o.plan_id')
    .select(['p.id as plan_id', 'p.name as plan_name', 'p.room_limit'])
    .where('o.id', '=', orgId);
  if (lock) q = q.forUpdate('o');
  const plan = await q.executeTakeFirstOrThrow();

  const { n } = await tx
    .selectFrom('rooms')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();
  return { planId: plan.plan_id, planName: plan.plan_name, roomLimit: plan.room_limit, activeRooms: n };
}

export function getPlanUsage(tx: Tx, orgId: string): Promise<PlanUsage> {
  return usage(tx, orgId, false);
}

/** Locks the org row, then throws 402 if one more active room would exceed the plan. */
export async function assertCanAddActiveRoom(tx: Tx, orgId: string): Promise<void> {
  const u = await usage(tx, orgId, true);
  if (u.roomLimit !== null && u.activeRooms >= u.roomLimit) {
    throw new HttpError(
      402,
      'PLAN_LIMIT_REACHED',
      `Your ${u.planName} plan allows ${u.roomLimit} active rooms. Upgrade to add more.`,
      u,
    );
  }
}
