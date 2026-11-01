// Controlled time for tests (decision 031): a TestClock the app and the infra harness inject in place of the system clock,
// and ManualTimers for code that schedules a timer (reconnect waits) and must not be waited for.
import type { Clock } from '../../src/common/clock';

/** One millisecond multiples that read well in tests. */
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * A clock that stands still until the test moves it.
 *
 * Why: a test that sets the time and advances it never waits and never meets a slow machine or a WSL clock step. By default
 * it starts at the real time of its creation (so values the database stamps with `default now()` stay close to it); pass a
 * date to start somewhere fixed.
 */
export class TestClock implements Clock {
  private ms: number;

  /** @param start where the clock starts: a date, epoch milliseconds, an ISO string, or (default) the real time now */
  constructor(start: Date | number | string = new Date()) {
    this.ms = typeof start === 'number' ? start : new Date(start).getTime();
  }

  /** The current test time as a new `Date`. */
  now(): Date {
    return new Date(this.ms);
  }

  /** The current test time in epoch milliseconds. */
  nowMs(): number {
    return this.ms;
  }

  /**
   * Puts the clock at a moment (forwards or backwards).
   *
   * @param to a date, epoch milliseconds or an ISO string
   */
  set(to: Date | number | string): void {
    this.ms = typeof to === 'number' ? to : new Date(to).getTime();
  }

  /**
   * Moves the clock forward.
   *
   * @param ms how far, in milliseconds (negative moves it back)
   * @returns the new time in epoch milliseconds
   */
  advance(ms: number): number {
    this.ms += ms;
    return this.ms;
  }

  /** Puts the clock back at the real time now, for a test that moved it far away and leaves shared state (caches) behind. */
  reset(): void {
    this.ms = Date.now();
  }
}

/** One timer waiting in {@link ManualTimers}. */
interface ManualTimer {
  readonly at: number;
  readonly run: () => void;
}

/**
 * `setTimeout` and `clearTimeout` that only fire when the test advances them.
 *
 * Why: reconnect waits (PgListener) are scheduled with timers; the test fires them by advancing virtual time instead of
 * sleeping for the delay. Pass `timers` of an instance to the code under test. Optionally moves a {@link TestClock} along.
 */
export class ManualTimers {
  private time = 0;
  private next = 0;
  private readonly waiting = new Map<number, ManualTimer>();

  /** @param clock a test clock to advance together with the timers */
  constructor(private readonly clock?: TestClock) {}

  /** Same shape as `setTimeout`: runs `run` after `ms` of virtual time. */
  readonly setTimeout = (run: () => void, ms: number): number => {
    const id = ++this.next;
    this.waiting.set(id, { at: this.time + ms, run });
    return id;
  };

  /** Same shape as `clearTimeout`. */
  readonly clearTimeout = (id: unknown): void => {
    if (typeof id === 'number') this.waiting.delete(id);
  };

  /** How many timers wait. */
  get pending(): number {
    return this.waiting.size;
  }

  /** The delays (from now, in milliseconds) of the waiting timers, soonest first. */
  get delays(): number[] {
    return [...this.waiting.values()].map((timer) => timer.at - this.time).sort((a, b) => a - b);
  }

  /**
   * Moves virtual time forward and runs every timer that falls due, in order (a timer set by a timer that ran is run too
   * when it falls inside the window).
   *
   * @param ms how far to move
   */
  advance(ms: number): void {
    const start = this.time;
    const clockStart = this.clock?.nowMs();
    const target = start + ms;
    const moveClockTo = (time: number) => {
      if (this.clock && clockStart !== undefined) this.clock.set(clockStart + (time - start));
    };
    for (;;) {
      let soonest: [number, ManualTimer] | undefined;
      for (const entry of this.waiting) {
        if (entry[1].at <= target && (!soonest || entry[1].at < soonest[1].at)) soonest = entry;
      }
      if (!soonest) break;
      this.waiting.delete(soonest[0]);
      this.time = Math.max(this.time, soonest[1].at);
      moveClockTo(this.time);
      soonest[1].run();
    }
    this.time = target;
    moveClockTo(target);
  }
}
