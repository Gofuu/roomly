import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { AuthSession } from '@roomly/shared';
import { config } from './config.js';
import { withTenant } from './db/index.js';
import { auth, requireAuth } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { invitationsRouter } from './team/invitations.js';
import { membersRouter } from './team/members.js';
import { spacesRouter } from './spaces/routes.js';
import { bookingsRouter } from './bookings/routes.js';
import { errorHandler, notFound, notFoundHandler } from './http/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  // In dev the Vite proxy makes everything same-origin; CORS covers a separately hosted frontend.
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const api = express.Router();
  app.use('/api', api);

  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  api.use('/auth', authRouter);

  // Everything below requires a valid access token.
  api.use(requireAuth);

  // Current user + org, read through RLS (also confirms the account still exists).
  api.get('/me', async (req, res) => {
    const { orgId, userId } = auth(req);
    const row = await withTenant(orgId, (tx) =>
      tx.selectFrom('users as u')
        .innerJoin('organizations as o', 'o.id', 'u.org_id')
        .select(['u.id', 'u.email', 'u.name', 'u.role', 'o.id as org_id', 'o.name as org_name', 'o.slug', 'o.plan_id'])
        .where('u.id', '=', userId)
        .where('u.is_active', '=', true)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('User');
    const body: Omit<AuthSession, 'accessToken' | 'expiresIn'> = {
      user: { id: row.id, email: row.email, name: row.name, role: row.role },
      org: { id: row.org_id, name: row.org_name, slug: row.slug, planId: row.plan_id },
    };
    res.json(body);
  });

  api.use('/invitations', invitationsRouter);
  api.use('/members', membersRouter);
  api.use(spacesRouter);
  api.use(bookingsRouter);

  api.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
