// How long an Idempotency-Key is remembered (REST v1, decision 026; MISMATCHES B166): the one number the purge job and the contracts share.

/**
 * Days a merchant's `Idempotency-Key` is remembered.
 *
 * Why: B166. A retry with the same key and body inside the window replays the first answer; after it the key is free again for that
 * merchant (a new order, not a replay), and the stored answer (delivered stock codes included) is gone. The placement that meets an
 * old key forgets it on the spot (`IdempotencyStore.run`), and the daily `idempotency_purge` cleans the keys nobody sends again.
 */
export const IDEMPOTENCY_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The moment before which keys have expired.
 *
 * Why: B166. One function ends the window for both places that enforce it, so they never disagree: the placement that finds an old stored
 * answer (`IdempotencyStore.run`) and the daily purge of keys nobody sends again (`IdempotencyPurge`). A record is expired when its
 * `created_at` is strictly before this moment; a key created exactly `IDEMPOTENCY_WINDOW_DAYS` ago still replays.
 *
 * @param nowMs the clock's time in epoch milliseconds (decision 031)
 * @returns `now` minus {@link IDEMPOTENCY_WINDOW_DAYS} days
 */
export function idempotencyCutoff(nowMs: number): Date {
  return new Date(nowMs - IDEMPOTENCY_WINDOW_DAYS * DAY_MS);
}
