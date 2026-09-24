/**
 * Retries a whole transaction when Postgres aborts it for a transient reason.
 *
 * Why bookings need this: an exclusion-constraint check happens *after* a row's
 * index entry is written. When two transactions insert overlapping bookings at
 * the same instant, each can find the other's uncommitted entry and wait for it,
 * forming a cycle. Postgres breaks the cycle by aborting one with 40P01
 * (deadlock_detected). No overlap is ever stored, but the victim did not get a
 * real answer. On retry it either succeeds or gets a definitive 23P01.
 *
 * Migration 003 (a per-room advisory lock taken before insert) prevents that
 * cycle for single-room writes, so this is a safety net rather than the main path.
 */
const TRANSIENT_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

export function isTransientDbError(err: unknown): boolean {
  return TRANSIENT_CODES.has((err as { code?: string })?.code ?? '');
}

export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxAttempts) throw err;
      // Jittered backoff so the retrying transactions do not collide again in lockstep.
      await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
    }
  }
}
