// The pure rules of the dispatch sweep (suppliers module, decision 044): when a lost dispatch request is asked for again and when it is given up.

/**
 * How long past the supplier's own timeout an unanswered claim waits before the sweep moves it to needs attention.
 *
 * Why: decision 044: the call itself ends at the supplier's `timeout_ms`; the margin covers the time to record the answer.
 */
export const DISPATCH_ANSWER_MARGIN_MS = 2 * 60_000;

/**
 * How long a waiting order must have gone without a dispatch request on its way before the sweep asks again.
 *
 * Why: decision 044: the relay and the job normally pick a request up within seconds, so five minutes means it was lost.
 */
export const DISPATCH_REQUEUE_AFTER_MS = 5 * 60_000;

/**
 * The age of the newest request after which an order is no longer sent automatically.
 *
 * Why: decision 044: an order that waited a day is a person's decision, and a first run on old data must not send forgotten orders.
 */
export const DISPATCH_REQUEUE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * How many times the sweep asks for the send of one order in its life.
 *
 * Why: decision 044: a job that fails for good every time must not loop.
 */
export const MAX_AUTOMATIC_REQUEUES = 3;

/**
 * The most orders one sweep run looks at per rule.
 *
 * Why: decision 044: a run stays short; the rest waits for the next minute.
 */
export const DISPATCH_SWEEP_BATCH = 100;

/**
 * The timeline sentence of an automatic new request.
 *
 * Why: decision 044: staff reading the order see why a send was queued again.
 */
export const REQUEUED_MESSAGE = 'Queued for sending again: the earlier send request did not run.';

/**
 * The reason of an order the sweep stops because its newest request is older than 24 hours.
 *
 * Why: decision 044: a person decides what happens to an order that waited this long.
 */
export const REQUEUE_TOO_OLD_REASON =
  'This order waited more than 24 hours for its send. Check it, then send it again.';

/**
 * The reason of an order the sweep stops after its automatic requests.
 *
 * Why: decision 044: the send could not be started; a person checks the order and its supplier.
 */
export const REQUEUE_LIMIT_REASON = `The send could not be started after ${MAX_AUTOMATIC_REQUEUES} automatic requests. Check the order and its supplier, then send it again.`;

/** What the sweep does with a waiting order: leave it, ask again, or stop it for a reason. */
export type LostRequestAction = 'wait' | 'requeue' | 'stop_old' | 'stop_repeated';

/**
 * Decides what the sweep does with a `pending` order that nobody claimed.
 *
 * Why: decision 044: ask again only when no request of the order is on its way and the last one is
 * old enough; never more than three times, never once the newest request is older than 24 hours. An order whose jobs could not be read
 * waits for the next run. An order that never had a request is left alone however old it is: every placement, release and staff send
 * writes its request in the same transaction as the order, so an order without any request row was not placed through the order engine
 * (seeded demo rows, for example) and nothing was lost.
 *
 * @param input whether a request is live (or unknown), when the newest was written (`null` when the order has none), how many
 *   automatic requests it already had and the clock's time
 * @returns `wait` (do nothing), `requeue` (ask again), `stop_old` or `stop_repeated` (move it to needs attention)
 */
export function lostRequestAction(input: {
  readonly requests: 'live' | 'none' | 'unknown';
  readonly lastRequestedAt: Date | null;
  readonly automaticRequeues: number;
  readonly now: Date;
}): LostRequestAction {
  if (input.requests !== 'none' || input.lastRequestedAt === null) return 'wait';
  const waited = input.now.getTime() - input.lastRequestedAt.getTime();
  if (waited < DISPATCH_REQUEUE_AFTER_MS) return 'wait';
  if (waited > DISPATCH_REQUEUE_MAX_AGE_MS) return 'stop_old';
  return input.automaticRequeues >= MAX_AUTOMATIC_REQUEUES ? 'stop_repeated' : 'requeue';
}
