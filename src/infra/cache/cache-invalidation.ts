// Retries of a cache invalidation that follows a security change (decision 055). Pure: the wait is passed in, so tests need no timers.

/**
 * The waits between the tries of an invalidation: three tries in all.
 *
 * Why: decision 055: a cache Redis that drops one command (a failover, a reconnect) must not leave the old entry of a revoked
 * session or a changed role in place; a short wait and two more tries cover a blip without holding the request for long.
 */
export const INVALIDATION_RETRY_DELAYS_MS: readonly number[] = [50, 250];

/** What {@link withRetries} ended with: the value of the first success, or the last error. */
export type RetryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number };

/**
 * Calls `attempt` until it resolves, waiting `delaysMs[i]` after the i-th failure, at most `delaysMs.length + 1` times.
 *
 * Why: decision 055: an invalidation runs after the commit, so it must never throw; the caller decides what a final failure means.
 *
 * @param attempt the work to try
 * @param delaysMs the waits between tries, in milliseconds
 * @param wait how to wait (the real `sleep`, or a recorder in tests)
 * @returns the first success with how many tries it took, or the last error after every try failed; never rejects
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[],
  wait: (ms: number) => Promise<void>,
): Promise<RetryOutcome<T>> {
  let lastError: unknown;
  for (let tries = 1; tries <= delaysMs.length + 1; tries++) {
    try {
      return { ok: true, value: await attempt(), attempts: tries };
    } catch (error) {
      lastError = error;
      const delay = delaysMs[tries - 1];
      // A wait that fails only shortens the pause: this function never rejects.
      if (delay !== undefined) await wait(delay).catch(() => undefined);
    }
  }
  return { ok: false, error: lastError, attempts: delaysMs.length + 1 };
}
