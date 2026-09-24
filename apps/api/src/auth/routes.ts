import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import { acceptInvitationSchema, loginSchema, signupSchema } from '@roomly/shared';
import { config, isProduction } from '../config.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { authRateLimit } from '../http/rate-limit.js';
import { acceptInvitation, login, logout, previewInvitation, rotateRefreshToken, signup, type IssuedSession } from './service.js';

export const REFRESH_COOKIE = 'roomly_rt';

const cookieOptions: CookieOptions = {
  httpOnly: true, // unreadable by JavaScript, so XSS cannot steal it
  secure: isProduction,
  sameSite: 'strict', // never sent on cross-site requests: the main CSRF defence
  path: '/api/auth', // only sent to the endpoints that need it
};

function sendSession(res: Response, issued: IssuedSession, status = 200) {
  res.cookie(REFRESH_COOKIE, issued.refreshToken, {
    ...cookieOptions,
    maxAge: config.auth.refreshTokenTtlDays * 86_400_000,
  });
  res.status(status).json(issued.session);
}

/**
 * Defence in depth for the cookie-authenticated endpoints: browsers always send
 * Origin on POST, so reject any that is not our own web app.
 */
const sameOriginOnly: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== config.webOrigin) return next(forbidden('Cross-origin request rejected'));
  next();
};

export const authRouter = Router();
authRouter.use(authRateLimit());

authRouter.post('/signup', async (req, res) => {
  sendSession(res, await signup(signupSchema.parse(req.body)), 201);
});

authRouter.post('/login', async (req, res) => {
  sendSession(res, await login(loginSchema.parse(req.body)));
});

authRouter.post('/refresh', sameOriginOnly, async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized('No session');
  try {
    sendSession(res, await rotateRefreshToken(token));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw err;
  }
});

authRouter.post('/logout', sameOriginOnly, async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) await logout(token);
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
});

authRouter.get('/invitations/:token', async (req, res) => {
  res.json(await previewInvitation(req.params.token));
});

authRouter.post('/invitations/accept', async (req, res) => {
  sendSession(res, await acceptInvitation(acceptInvitationSchema.parse(req.body)), 201);
});
