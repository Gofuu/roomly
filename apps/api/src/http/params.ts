import type { Request, Router } from 'express';
import { notFound } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed :id can't match any row, so answer 404 instead of letting Postgres raise 22P02. */
export function validateIdParams(router: Router, ...names: string[]) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value) => (UUID.test(String(value)) ? next() : next(notFound())));
  }
}

/** A route parameter as a string (Express types widen params when route-level middleware is present). */
export function param(req: Request, name: string): string {
  return String(req.params[name]);
}
