/**
 * Authentication flows. These run before a tenant is known (or, for refresh, must
 * read a table the tenant role cannot see), so they use the privileged withSystem
 * handle. Each function checks everything it relies on explicitly.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AcceptInvitationInput, AuthOrg, AuthSession, AuthUser, InvitationPreview, LoginInput, SignupInput } from '@roomly/shared';
import { config } from '../config.js';
import { withSystem, type Tx } from '../db/index.js';
import { HttpError, conflict, unauthorized } from '../http/errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import { generateOpaqueToken, hashToken, signAccessToken } from './tokens.js';

export interface IssuedSession {
  session: AuthSession;
  /** Raw refresh token for the httpOnly cookie. Never returned in a response body. */
  refreshToken: string;
}

type UserWithOrg = {
  id: string; email: string; name: string; role: 'admin' | 'employee'; is_active: boolean;
  org_id: string; org_name: string; org_slug: string; plan_id: string;
};

function selectUserWithOrg(tx: Tx) {
  return tx
    .selectFrom('users as u')
    .innerJoin('organizations as o', 'o.id', 'u.org_id')
    .select([
      'u.id', 'u.email', 'u.name', 'u.role', 'u.is_active', 'u.password_hash',
      'o.id as org_id', 'o.name as org_name', 'o.slug as org_slug', 'o.plan_id',
    ]);
}

/** Creates a refresh token (starting a new family unless one is given) and signs an access token. */
async function issueSession(tx: Tx, u: UserWithOrg, familyId: string = randomUUID()): Promise<IssuedSession & { tokenId: string }> {
  const refreshToken = generateOpaqueToken();
  const { id: tokenId } = await tx
    .insertInto('refresh_tokens')
    .values({
      user_id: u.id,
      family_id: familyId,
      token_hash: hashToken(refreshToken),
      expires_at: new Date(Date.now() + config.auth.refreshTokenTtlDays * 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const user: AuthUser = { id: u.id, email: u.email, name: u.name, role: u.role };
  const org: AuthOrg = { id: u.org_id, name: u.org_name, slug: u.org_slug, planId: u.plan_id };
  const accessToken = await signAccessToken({ userId: u.id, orgId: u.org_id, role: u.role });
  return {
    session: { accessToken, expiresIn: config.auth.accessTokenTtlSeconds, user, org },
    refreshToken,
    tokenId,
  };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'org';
}

/** Creates a new organization with the signing-up user as its first admin. */
export async function signup(input: SignupInput): Promise<IssuedSession> {
  const passwordHash = await hashPassword(input.password); // slow; do it before opening a transaction
  return withSystem(async (tx) => {
    const existing = await tx.selectFrom('users').select('id').where('email', '=', input.email).executeTakeFirst();
    if (existing) throw conflict('EMAIL_TAKEN', 'An account with that email already exists');

    let slug = slugify(input.orgName);
    const taken = await tx.selectFrom('organizations').select('id').where('slug', '=', slug).executeTakeFirst();
    if (taken) slug = `${slug}-${randomBytes(3).toString('hex')}`;

    const org = await tx
      .insertInto('organizations')
      .values({ name: input.orgName, slug })
      .returning(['id', 'name', 'slug', 'plan_id'])
      .executeTakeFirstOrThrow();
    const user = await tx
      .insertInto('users')
      .values({ org_id: org.id, email: input.email, name: input.name, password_hash: passwordHash, role: 'admin' })
      .returning(['id', 'email', 'name', 'role', 'is_active'])
      .executeTakeFirstOrThrow();

    return issueSession(tx, {
      ...user, org_id: org.id, org_name: org.name, org_slug: org.slug, plan_id: org.plan_id,
    });
  });
}

export async function login(input: LoginInput): Promise<IssuedSession> {
  const user = await withSystem((tx) => selectUserWithOrg(tx).where('u.email', '=', input.email).executeTakeFirst());

  // Always run one argon2 verification so response time does not reveal whether the email exists.
  const ok = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), input.password);
  if (!user || !ok) throw unauthorized('Incorrect email or password');
  if (!user.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated');

  return withSystem((tx) => issueSession(tx, user));
}

/**
 * Exchanges a refresh token for a new access token AND a new refresh token.
 *
 * Reuse detection: a refresh token is valid exactly once. If an already-rotated
 * token is presented again, either the legitimate client or an attacker holds a
 * stolen copy — we cannot tell which — so the whole family (every token descended
 * from that login) is revoked and both must log in again.
 *
 * The revocation must survive, so the transaction reports what happened and the
 * error is thrown *after* COMMIT (throwing inside would roll the revocation back).
 */
export async function rotateRefreshToken(rawToken: string): Promise<IssuedSession> {
  const outcome = await withSystem(async (tx) => {
    // FOR UPDATE: two simultaneous refreshes with the same token serialize here, so
    // exactly one rotates it and the other is treated as reuse.
    const token = await tx
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hashToken(rawToken))
      .forUpdate()
      .executeTakeFirst();
    if (!token) return { error: 'INVALID' as const };

    const revokeFamily = () =>
      tx.updateTable('refresh_tokens')
        .set({ revoked_at: sql`now()` })
        .where('family_id', '=', token.family_id)
        .where('revoked_at', 'is', null)
        .execute();

    if (token.revoked_at) {
      await revokeFamily();
      return { error: 'REUSED' as const };
    }
    if (token.expires_at < new Date()) return { error: 'EXPIRED' as const };

    const user = await selectUserWithOrg(tx).where('u.id', '=', token.user_id).executeTakeFirstOrThrow();
    if (!user.is_active) {
      await revokeFamily();
      return { error: 'DISABLED' as const };
    }

    const issued = await issueSession(tx, user, token.family_id);
    await tx
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql`now()`, replaced_by: issued.tokenId })
      .where('id', '=', token.id)
      .execute();
    return { issued };
  });

  if ('error' in outcome) {
    const messages = {
      INVALID: 'Session not found. Please log in again.',
      REUSED: 'This session was already used elsewhere and has been signed out for safety. Please log in again.',
      EXPIRED: 'Your session has expired. Please log in again.',
      DISABLED: 'This account has been deactivated.',
    } as const;
    throw new HttpError(401, `REFRESH_${outcome.error}`, messages[outcome.error!]);
  }
  return outcome.issued;
}

/** Revokes every token in the presented token's family (this login, on this device). */
export async function logout(rawToken: string): Promise<void> {
  await withSystem(async (tx) => {
    const token = await tx
      .selectFrom('refresh_tokens')
      .select('family_id')
      .where('token_hash', '=', hashToken(rawToken))
      .executeTakeFirst();
    if (!token) return;
    await tx.updateTable('refresh_tokens')
      .set({ revoked_at: sql`now()` })
      .where('family_id', '=', token.family_id)
      .where('revoked_at', 'is', null)
      .execute();
  });
}

/** Revokes all of a user's sessions everywhere (used when an admin deactivates them). */
export async function revokeAllSessions(tx: Tx, userId: string): Promise<void> {
  await tx.updateTable('refresh_tokens')
    .set({ revoked_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}

// -----------------------------------------------------------------------------
// Invitation acceptance (the invitee has no account or tenant context yet)
// -----------------------------------------------------------------------------

const invalidInvite = () =>
  new HttpError(404, 'INVITATION_INVALID', 'This invitation link is invalid, expired, or has already been used');

function findOpenInvitation(tx: Tx, rawToken: string) {
  return tx
    .selectFrom('invitations as i')
    .innerJoin('organizations as o', 'o.id', 'i.org_id')
    .select(['i.id', 'i.org_id', 'i.email', 'i.role', 'o.name as org_name', 'o.slug as org_slug', 'o.plan_id'])
    .where('i.token_hash', '=', hashToken(rawToken))
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null)
    .where('i.expires_at', '>', sql<Date>`now()`);
}

export async function previewInvitation(rawToken: string): Promise<InvitationPreview> {
  const inv = await withSystem((tx) => findOpenInvitation(tx, rawToken).executeTakeFirst());
  if (!inv) throw invalidInvite();
  return { email: inv.email, orgName: inv.org_name, role: inv.role };
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<IssuedSession> {
  const passwordHash = await hashPassword(input.password);
  return withSystem(async (tx) => {
    // FOR UPDATE OF i: accepting the same link twice at once cannot create two users.
    const inv = await findOpenInvitation(tx, input.token).forUpdate('i').executeTakeFirst();
    if (!inv) throw invalidInvite();

    const existing = await tx.selectFrom('users').select('id').where('email', '=', inv.email).executeTakeFirst();
    if (existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');

    const user = await tx
      .insertInto('users')
      .values({ org_id: inv.org_id, email: inv.email, name: input.name, password_hash: passwordHash, role: inv.role })
      .returning(['id', 'email', 'name', 'role', 'is_active'])
      .executeTakeFirstOrThrow();
    await tx.updateTable('invitations').set({ accepted_at: sql`now()` }).where('id', '=', inv.id).execute();

    return issueSession(tx, {
      ...user, org_id: inv.org_id, org_name: inv.org_name, org_slug: inv.org_slug, plan_id: inv.plan_id,
    });
  });
}
