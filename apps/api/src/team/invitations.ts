import { Router } from 'express';
import { sql } from 'kysely';
import { createInvitationSchema, type Invitation } from '@roomly/shared';
import { config } from '../config.js';
import { withTenant } from '../db/index.js';
import { auth, requireAdmin } from '../auth/middleware.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import { conflict, notFound } from '../http/errors.js';
import { validateIdParams } from '../http/params.js';

/** Admin-only invitation management. Mounted behind requireAuth. */
export const invitationsRouter = Router();
invitationsRouter.use(requireAdmin);
validateIdParams(invitationsRouter, 'id');

invitationsRouter.get('/', async (req, res) => {
  const { orgId } = auth(req);
  const rows = await withTenant(orgId, (tx) =>
    tx.selectFrom('invitations as i')
      .innerJoin('users as u', 'u.id', 'i.invited_by')
      .select(['i.id', 'i.email', 'i.role', 'i.expires_at', 'i.created_at', 'u.name as invited_by'])
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .where('i.expires_at', '>', sql<Date>`now()`)
      .orderBy('i.created_at', 'desc')
      .execute(),
  );
  const out: Invitation[] = rows.map((r) => ({
    id: r.id, email: r.email, role: r.role, invitedBy: r.invited_by,
    expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(),
  }));
  res.json(out);
});

/**
 * Creates an invitation and returns its one-time link. There is no email service
 * in this project, so the admin copies the link (a real deployment would send it
 * via SES/Postmark here). Re-inviting the same email replaces the old link.
 */
invitationsRouter.post('/', async (req, res) => {
  const { orgId, userId } = auth(req);
  const input = createInvitationSchema.parse(req.body);
  const token = generateOpaqueToken();

  const inv = await withTenant(orgId, async (tx) => {
    // RLS limits this to our own org. Accounts in other orgs are checked at
    // acceptance time, so admins cannot probe which emails exist elsewhere.
    const member = await tx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst();
    if (member) throw conflict('ALREADY_MEMBER', 'That person is already a member of your organization');

    await tx.updateTable('invitations')
      .set({ revoked_at: sql`now()` })
      .where('email', '=', input.email)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();

    return tx.insertInto('invitations')
      .values({
        org_id: orgId,
        email: input.email,
        role: input.role,
        token_hash: hashToken(token),
        invited_by: userId,
        expires_at: new Date(Date.now() + config.auth.inviteTtlDays * 86_400_000),
      })
      .returning(['id', 'email', 'role', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
  });

  const inviteUrl = `${config.webOrigin}/invite/${token}`;
  if (config.env === 'development') console.info(`[invite] ${inv.email}: ${inviteUrl}`);
  res.status(201).json({
    invitation: { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expires_at, createdAt: inv.created_at },
    inviteUrl,
  });
});

invitationsRouter.delete('/:id', async (req, res) => {
  const { orgId } = auth(req);
  const result = await withTenant(orgId, (tx) =>
    tx.updateTable('invitations')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', req.params.id)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!result.numUpdatedRows) throw notFound('Invitation');
  res.status(204).end();
});
