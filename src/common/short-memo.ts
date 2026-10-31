// A memo that keeps one async value for a moment: one load at a time, a fresh value for `ttlMs`, and the last good value when a
// reload fails. Used by the request pipeline hooks, which read their rules on every request.

/**
 * Options of {@link ShortMemo}.
 *
 * Why: freshness is the only real setting; the clock and the callback exist so that tests and logs can reach the memo.
 */
export interface ShortMemoOptions {
  /** How long a loaded value counts as fresh, in milliseconds. */
  readonly ttlMs: number;
  /** Clock in milliseconds; monotonic by default, replaceable in tests. */
  readonly now?: () => number;
  /** Called when a failed reload was answered with the last good value. */
  readonly onStale?: (error: unknown) => void;
}

/**
 * Remembers the result of an async load for a short time.
 *
 * Why: the pipeline hooks (IP rules, maintenance) run on every request. Their rules live in Redis and Postgres; a memo of a
 * second or so keeps the common request off both, and keeps Postgres from being asked once per request while the Redis cache
 * is down. A reload that fails serves the last good value (the rules cannot get worse because a database blinked); after
 * {@link ShortMemo.clear} there is no last good value, so a failed reload throws instead of serving data known to be old.
 *
 * Side effects: none outside the process.
 */
export class ShortMemo<T> {
  private current: { readonly value: T; readonly at: number } | undefined;
  private loading: Promise<T> | undefined;
  /** Bumped by `clear`: a load that started before it must not store its (possibly older) result. */
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onStale: ((error: unknown) => void) | undefined;

  /** @param options freshness, clock and the stale callback */
  constructor(options: ShortMemoOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => performance.now());
    this.onStale = options.onStale;
  }

  /**
   * Returns the fresh value, or loads it (one load at a time; concurrent callers share it).
   *
   * @param load reads the value from its source
   * @returns the value; the last good one when the reload failed and nothing has cleared the memo since
   * @throws whatever `load` throws when there is no last good value
   */
  async get(load: () => Promise<T>): Promise<T> {
    const held = this.current;
    if (held && this.now() - held.at < this.ttlMs) return held.value;
    const flight = (this.loading ??= this.start(load, this.generation));
    try {
      return await flight;
    } catch (error) {
      // `current` is only set while it may still be served: `clear` removes it.
      const fallback = this.current;
      if (!fallback) throw error;
      this.onStale?.(error);
      return fallback.value;
    }
  }

  /** Forgets the value and detaches any load in progress, so the next call reads the source. */
  clear(): void {
    this.generation++;
    this.current = undefined;
    this.loading = undefined;
  }

  private start(load: () => Promise<T>, generation: number): Promise<T> {
    const flight: Promise<T> = load()
      .then((value) => {
        if (generation === this.generation) this.current = { value, at: this.now() };
        return value;
      })
      .finally(() => {
        if (this.loading === flight) this.loading = undefined;
      });
    return flight;
  }
}
