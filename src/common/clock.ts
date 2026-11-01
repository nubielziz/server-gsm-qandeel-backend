// The Clock: the one place that reads the wall clock (decision 031). Every decision that depends on the time of day
// (expiries, token lifetimes, touch throttling, cache freshness, windows) asks the injected `Clock`, so tests can control time.
// Next to it, the Timers that code schedules retries and deadlines with, so tests can fire them without waiting.

/**
 * A source of the current time.
 *
 * Why: decision 031. Code that decides on the wall clock reads it from here instead of `Date.now()`, so a test can set the
 * time, move it forward and never wait for it (no sleeps, no margins that a stepped WSL clock can break).
 */
export interface Clock {
  /**
   * The current time.
   *
   * @returns a new `Date` on every call, so a caller may keep or change it
   */
  now(): Date;
  /**
   * The current time in epoch milliseconds.
   *
   * @returns the same instant as `now().getTime()`
   */
  nowMs(): number;
}

/**
 * Nest injection token of the {@link Clock}; provided globally by `ClockModule`.
 *
 * Why: services inject it with `@Inject(CLOCK) private readonly clock: Clock`.
 */
export const CLOCK = Symbol('CLOCK');

/**
 * The real clock: the system time.
 *
 * Why: production reads the machine's clock. This file is the only one under `src/` that may call `Date.now()` or
 * `new Date()` without arguments (lint rule `gsm/no-wall-clock`, decision 031).
 */
export class SystemClock implements Clock {
  /** @inheritdoc */
  now(): Date {
    return new Date();
  }

  /** @inheritdoc */
  nowMs(): number {
    return Date.now();
  }
}

/**
 * The two timer functions that code schedules a retry or a deadline with.
 *
 * Why: decision 031. A reconnect wait, a scheduler retry or a health deadline is a wait of real time in production; a test
 * replaces the timers with manual ones and fires them by moving virtual time, so it never sleeps through the delay.
 */
export interface Timers {
  /**
   * Schedules `run` after a delay.
   *
   * @param run what to do when the delay is over
   * @param ms the delay in milliseconds
   * @returns a handle for {@link Timers.clearTimeout}
   */
  setTimeout(run: () => void, ms: number): unknown;
  /**
   * Cancels a timer.
   *
   * @param handle what {@link Timers.setTimeout} returned
   */
  clearTimeout(handle: unknown): void;
}

/**
 * Nest injection token of the {@link Timers}; provided globally by `ClockModule`.
 *
 * Why: services inject it with `@Inject(TIMERS) private readonly timers: Timers`.
 */
export const TIMERS = Symbol('TIMERS');

/**
 * The real timers: Node's `setTimeout` and `clearTimeout`.
 *
 * Why: production waits in real time. A timer is not a decision on the time of day, so it is not under the lint rule; it
 * only needs to be replaceable.
 */
export const systemTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
