// The temporary lock after repeated failed sign-ins of a customer email (map: "locks temporarily after repeated failures",
// ALIGNMENT § 3: answered as 429). Pure rules; the counters live in the cache Redis (infra/customer-sign-in-failures).

/** Consecutive wrong passwords that lock an email. */
export const MAX_FAILED_ATTEMPTS = 10;
/** How long a locked email refuses sign-in. */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Tells whether a failure count is enough to lock.
 *
 * Why: the tenth wrong password in a row sets the lock; the count of an email nobody owns grows the same way, so a lock never
 * tells an attacker whether an account exists.
 *
 * @param failures wrong passwords counted since the last success or lock
 * @returns true from the tenth failure on
 */
export function locksAfter(failures: number): boolean {
  return failures >= MAX_FAILED_ATTEMPTS;
}

/**
 * Tells how many seconds an email stays locked.
 *
 * @param lockedUntilMs the end of the lock in epoch milliseconds, or `0` when the email was never locked
 * @param nowMs the clock's time in milliseconds
 * @returns whole seconds (at least 1) while locked, or `0` when the email is not locked
 */
export function lockedForSeconds(lockedUntilMs: number, nowMs: number): number {
  const left = lockedUntilMs - nowMs;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
