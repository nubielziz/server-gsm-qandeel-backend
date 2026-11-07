// The rhythm of the status polls (decision 025, scenario success step 8): every minute for the first hour, then every five minutes,
// then every thirty minutes once the order is older than `orders.poll_slow_after_hours` (default 24). Pure.

/** The default of the setting `orders.poll_slow_after_hours`. */
export const DEFAULT_POLL_SLOW_AFTER_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long to wait between two polls of an order that was sent `ageMs` ago.
 *
 * @param ageMs time since the order was sent
 * @param slowAfterHours after this many hours the polls are 30 minutes apart
 * @returns the wait in milliseconds
 */
export function pollIntervalMs(ageMs: number, slowAfterHours: number): number {
  if (ageMs < HOUR_MS) return MINUTE_MS;
  if (ageMs < slowAfterHours * HOUR_MS) return 5 * MINUTE_MS;
  return 30 * MINUTE_MS;
}
