// The rule that decides whether outbox-driven work was lost (platform module, decision 055). Pure, unit-tested.

/**
 * A request younger than this is never judged lost.
 *
 * Why: decision 055: the relay hands an event over within seconds and a job waits at most its queue's backoff; ten minutes leaves room
 * for a slow worker start without leaving lost work waiting long.
 */
export const LOST_AFTER_MS = 10 * 60_000;

/**
 * Automatic re-requests per row in its life.
 *
 * Why: decision 055: work that is lost again and again needs a person; each kind then gives up in its own way.
 */
export const MAX_RECONCILE_REQUESTS = 3;

/** Whether a row's requests are on their way: `live`, `none`, or `unknown` when the queue Redis could not be read. */
export type OutboxRequestState = 'live' | 'none' | 'unknown';

/** What to do with a row that waits for a job. */
export type LostWorkAction = 'wait' | 'request' | 'give_up' | 'unknown' | 'never_requested';

/**
 * Judges a row that waits for a job.
 *
 * Why: decision 055: "lost" is decided the same way for every outbox-driven kind, in this order: jobs that cannot be read decide
 * nothing; a live request (not relayed yet, or its job waits, runs or is delayed) is waited for, however old; a row with no request is
 * left alone; a request younger than {@link LOST_AFTER_MS} is waited for; after {@link MAX_RECONCILE_REQUESTS} automatic requests the
 * kind gives up; otherwise the work is asked for again.
 *
 * @param input the request state, when the newest request was written, how many automatic re-requests the row had, and the time now
 * @returns the action
 */
export function lostWorkAction(input: {
  readonly state: OutboxRequestState;
  readonly newestAt: Date | null;
  readonly reconcileRequests: number;
  readonly now: Date;
}): LostWorkAction {
  if (input.state === 'unknown') return 'unknown';
  if (input.state === 'live') return 'wait';
  if (input.newestAt === null) return 'never_requested';
  if (input.now.getTime() - input.newestAt.getTime() < LOST_AFTER_MS) return 'wait';
  if (input.reconcileRequests >= MAX_RECONCILE_REQUESTS) return 'give_up';
  return 'request';
}
