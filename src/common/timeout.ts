// Small promise helpers for infrastructure code: a deadline that cleans up its timer, and a sleep.
import { setTimeout as delay } from 'node:timers/promises';

/** Thrown by {@link withTimeout} when the deadline passes first. */
export class TimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    label: string,
  ) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Waits for a promise, but not longer than a deadline.
 *
 * Why: startup and shutdown steps (connecting Redis, quitting clients) must never hang the whole process on one
 * unreachable dependency. The timer is always cleared, so a finished call leaves nothing behind.
 *
 * Side effects: none; the underlying work is not cancelled, only no longer awaited (its rejection is swallowed).
 *
 * @param work the pending operation
 * @param timeoutMs the deadline in milliseconds
 * @param label what is being waited for, used in the error message
 * @returns what `work` resolved with
 * @throws {TimeoutError} when the deadline passes first; whatever `work` rejected with otherwise
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timer = new AbortController();
  // If the deadline wins, a later rejection of `work` must not become an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      delay(timeoutMs, undefined, { signal: timer.signal }).then(() => {
        throw new TimeoutError(timeoutMs, label);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

/**
 * Waits for a number of milliseconds.
 *
 * @param ms how long to wait
 * @returns resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return delay(ms);
}
