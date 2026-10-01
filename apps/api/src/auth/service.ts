/**
 * Signup, login, refresh, logout and invitation acceptance. These run before a
 * company is known, so they use withDb and touch only organizations, users,
 * invitations and refresh_tokens.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { AcceptInvitationInput, AuthSession, InvitationPreview, LoginInput, SignupInput } from '@roomly/shared';
import { config } from '../config.js';
import { withDb, type Tx } from '../db/index.js';
import { HttpError, conflict, unauthorized } from '../http/errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import { generateOpaqueToken, hashToken, signAccessToken } from './tokens.js';

export interface IssuedSession {
  session: AuthSession;
  /** Raw refresh token for the httpOnly cookie. Never sent in a response body. */
  refreshToken: string;
}

function selectUserWithOrg(tx: Tx) {
  return tx
    .selectFrom('users as u')
    .innerJoin('organizations as o', 'o.id', 'u.org_id')
    .select([
      'u.id', 'u.email', 'u.name', 'u.role', 'u.is_active', 'u.password_hash',
      'o.id as org_id', 'o.name as org_name', 'o.slug as org_slug', 'o.plan_id',
    ]);
}

/** Stores a new refresh token and signs an access token for the user. */
async function issueSession(tx: Tx, userId: string): Promise<IssuedSession> {
  const u = await selectUserWithOrg(tx).where('u.id', '=', userId).executeTakeFirstOrThrow();
  const refreshToken = generateOpaqueToken();
  await tx.insertInto('refresh_tokens')
    .values({
      user_id: u.id,
      token_hash: hashToken(refreshToken),
      expires_at: new Date(Date.now() + config.auth.refreshTokenTtlDays * 86_400_000),
    })
    .execute();
  const accessToken = await signAccessToken({ userId: u.id, orgId: u.org_id, role: u.role });
  return {
    refreshToken,
    session: {
      accessToken,
      expiresIn: config.auth.accessTokenTtlSeconds,
      user: { id: u.id, email: u.email, name: u.name, role: u.role },
      org: { id: u.org_id, name: u.org_name, slug: u.org_slug, planId: u.plan_id },
    },
  };
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'org';
}

/** Creates a new company with the person signing up as its first admin. */
export async function signup(input: SignupInput): Promise<IssuedSession> {
  const passwordHash = await hashPassword(input.password); // slow on purpose; do it before the transaction
  return withDb(async (tx) => {
    const existing = await tx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst();
    if (existing) throw conflict('EMAIL_TAKEN', 'An account with that email already exists');

    let slug = slugify(input.orgName);
    const taken = await tx.selectFrom('organizations').select('id').where('slug', '=', slug).executeTakeFirst();
    if (taken) slug = `${slug}-${randomBytes(3).toString('hex')}`;

    const org = await tx.insertInto('organizations').values({ name: input.orgName, slug })
      .returning('id').executeTakeFirstOrThrow();
    const user = await tx.insertInto('users')
      .values({ org_id: org.id, email: input.email, name: input.name, password_hash: passwordHash, role: 'admin' })
      .returning('id').executeTakeFirstOrThrow();
    return issueSession(tx, user.id);
  });
}

export async function login(input: LoginInput): Promise<IssuedSession> {
  const user = await withDb((tx) => selectUserWithOrg(tx).where('u.email', '=', input.email).executeTakeFirst());

  // Always check one password hash, so the response time does not reveal whether the email exists.
  const ok = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), input.password);
  if (!user || !ok) throw unauthorized('Incorrect email or password');
  if (!user.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated');

  return withDb((tx) => issueSession(tx, user.id));
}

/**
 * Swaps a refresh token for a new access token and a new refresh token.
 * The old token row is deleted, so each refresh token works exactly once.
 */
export async function refreshSession(rawToken: string): Promise<IssuedSession> {
  return withDb(async (tx) => {
    // DELETE ... RETURNING: if two requests arrive with the same token, only one gets the row.
    const token = await tx.deleteFrom('refresh_tokens')
      .where('token_hash', '=', hashToken(rawToken))
      .returning(['user_id', 'expires_at'])
      .executeTakeFirst();
    if (!token || token.expires_at < new Date()) throw unauthorized('Your session has expired. Please log in again.');

    const user = await tx.selectFrom('users').select('is_active').where('id', '=', token.user_id).executeTakeFirst();
    if (!user?.is_active) throw unauthorized('This account has been deactivated.');
    return issueSession(tx, token.user_id);
  });
}

export async function logout(rawToken: string): Promise<void> {
  await withDb((tx) => tx.deleteFrom('refresh_tokens').where('token_hash', '=', hashToken(rawToken)).execute());
}

// -----------------------------------------------------------------------------
// Accepting an invitation (the invitee has no account yet)
// -----------------------------------------------------------------------------

const invalidInvite = () =>
  new HttpError(404, 'INVITATION_INVALID', 'This invitation link is invalid, expired, or has already been used');

function findOpenInvitation(tx: Tx, rawToken: string) {
  return tx
    .selectFrom('invitations as i')
    .innerJoin('organizations as o', 'o.id', 'i.org_id')
    .select(['i.id', 'i.org_id', 'i.email', 'i.role', 'o.name as org_name'])
    .where('i.token_hash', '=', hashToken(rawToken))
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null)
    .where('i.expires_at', '>', sql<Date>`now()`);
}

export async function previewInvitation(rawToken: string): Promise<InvitationPreview> {
  const inv = await withDb((tx) => findOpenInvitation(tx, rawToken).executeTakeFirst());
  if (!inv) throw invalidInvite();
  return { email: inv.email, orgName: inv.org_name, role: inv.role };
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<IssuedSession> {
  const passwordHash = await hashPassword(input.password);
  return withDb(async (tx) => {
    // FOR UPDATE: opening the same link twice at once cannot create two users.
    const inv = await findOpenInvitation(tx, input.token).forUpdate('i').executeTakeFirst();
    if (!inv) throw invalidInvite();

    const existing = await tx.selectFrom('users').select('id').where('email', '=', inv.email).executeTakeFirst();
    if (existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');

    const user = await tx.insertInto('users')
      .values({ org_id: inv.org_id, email: inv.email, name: input.name, password_hash: passwordHash, role: inv.role })
      .returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('invitations').set({ accepted_at: sql`now()` }).where('id', '=', inv.id).execute();
    return issueSession(tx, user.id);
  });
}
