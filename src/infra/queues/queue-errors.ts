// Tells "the queue Redis cannot take this right now" apart from a mistake in the call itself (decision 006).

/** Connection-level failures of ioredis and the socket under it. */
const CONNECTION_MESSAGE =
  /Stream isn't writeable|enableOfflineQueue|Connection is closed|Command timed out|Reached the max retries|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|Connection lost|client is closed/i;
/** Replies a Redis that is up but unable to work sends (full noeviction instance, loading its dataset, replica, ...). */
const REDIS_STATE_REPLY = /^(OOM|LOADING|READONLY|MISCONF|BUSY|CLUSTERDOWN|TRYAGAIN|NOREPLICAS)\b/;

/**
 * Tells whether an error means the queue Redis is unreachable or unable to take writes right now.
 *
 * Why: a producer fails fast while Redis is down (decision 006), and the caller must then keep the work in Postgres (the
 * outbox) and answer `503 UNAVAILABLE`, while a mistake in the call (a bad job id, an oversized payload) is a bug and must
 * stay a plain error. The queue Redis runs with `noeviction`, so a full instance answers `OOM` to every write: that is
 * "unavailable" too.
 *
 * @param error whatever `Queue.add` and friends rejected with
 * @returns true when waiting and trying again could succeed, false for an error in the call itself
 */
export function isQueueUnavailableError(error: unknown): boolean {
  let current: unknown = error;
  // BullMQ and Drizzle-style wrappers keep the original error as `cause`.
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if (current.name === 'MaxRetriesPerRequestError') return true;
    if (CONNECTION_MESSAGE.test(current.message) || REDIS_STATE_REPLY.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
