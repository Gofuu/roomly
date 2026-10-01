/**
 * Retries a whole transaction when Postgres aborts it for a transient reason.
 *
 * A deadlock (40P01) means Postgres picked this transaction to abort so that
 * others could continue. Nothing was saved and nothing is wrong with the
 * request, so running it again gives it a real answer. Bookings for one room
 * are queued by a trigger and should not deadlock, but transactions that touch
 * several rows (for example cancelling all of a user's bookings) still can.
 */
const TRANSIENT_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

export async function retryTransient<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      if (!TRANSIENT_CODES.has(code) || attempt >= maxAttempts) throw err;
      // A short random pause so the retrying transactions don't collide again.
      await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
    }
  }
}
