// Lets a repeating log message through at most once per interval (Redis and S3 outages repeat the same error on every
// retry and every request; one line per interval is enough to alert on and keeps the log readable).

/**
 * Rate-limits a log message per key.
 *
 * Why: during an outage the same connection error fires on every reconnect attempt and every cache call; without a
 * throttle the log fills with identical lines and hides everything else.
 */
export class LogThrottle {
  private readonly lastAllowed = new Map<string, number>();
  private readonly suppressedSince = new Map<string, number>();

  /**
   * @param intervalMs the shortest time between two lines with the same key
   * @param now clock in milliseconds, replaceable in tests; monotonic by default, so a stepped system clock cannot mute
   *   or flood the log
   */
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Asks whether a message with this key may be logged now.
   *
   * @param key what repeats, for example `redis:cache:error`
   * @returns `undefined` when the message must be dropped, otherwise how many were dropped since the last one logged
   */
  attempt(key: string): { readonly suppressed: number } | undefined {
    const time = this.now();
    const last = this.lastAllowed.get(key);
    if (last !== undefined && time - last < this.intervalMs) {
      this.suppressedSince.set(key, (this.suppressedSince.get(key) ?? 0) + 1);
      return undefined;
    }
    this.lastAllowed.set(key, time);
    const suppressed = this.suppressedSince.get(key) ?? 0;
    this.suppressedSince.delete(key);
    return { suppressed };
  }
}
