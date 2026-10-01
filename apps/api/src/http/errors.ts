import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config.js';

/** An error with an HTTP status and a stable machine-readable code for the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** Postgres SQLSTATE of a driver error, if it is one. */
export function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route'));

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: err.flatten() },
    });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  // Other client errors raised by middleware (e.g. body-parser's 413) carry their own status.
  const status = (err as { status?: unknown; expose?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500 && (err as { expose?: unknown }).expose) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    return;
  }
  // Constraint violations that route handlers did not translate themselves.
  switch (pgErrorCode(err)) {
    case '23P01':
      res.status(409).json({ error: { code: 'CONFLICT', message: 'That conflicts with an existing record' } });
      return;
    case '23505':
      res.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'That already exists' } });
      return;
    case '23503':
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'A referenced record does not exist' } });
      return;
    case '23514':
    case '22000':
    case '22P02':
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid value' } });
      return;
  }
  console.error(err);
  res.status(500).json({
    error: { code: 'INTERNAL', message: isProduction ? 'Something went wrong' : String((err as Error)?.message ?? err) },
  });
};
