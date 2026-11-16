// SearchCircuit: the API's circuit breaker in front of the search engine (feature 29, plan section 3.4). While it is open every search
// is the Postgres fallback without a call, which also bounds OutboundHttp's warning lines to about one per 15 s.
import type { Clock } from '../../common/clock';
import { SearchNotReady, SearchUnavailable } from './search-errors';

/** Where the circuit stands. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** The numbers of the circuit (plan section 3.4). */
export interface SearchCircuitOptions {
  /** Ordinary failures within {@link SearchCircuitOptions.windowMs} that open the circuit (3). */
  readonly failureThreshold: number;
  /** The window of the ordinary failures (30 s). */
  readonly windowMs: number;
  /** How long the circuit stays open before one probe request (15 s). */
  readonly openMs: number;
}

/** The plan's numbers: 3 failures in 30 s, open for 15 s. */
export const SEARCH_CIRCUIT_DEFAULTS: SearchCircuitOptions = { failureThreshold: 3, windowMs: 30_000, openMs: 15_000 };

/**
 * Tells whether a failure opens the circuit at once.
 *
 * Why: plan section 3.4: a 5xx, a refused key, a node out of resources and a missing alias will not heal within the next request;
 * timeouts and connection errors may be one slow moment, so they count towards the threshold instead.
 *
 * @param error what the call threw
 * @returns true for `SearchUnavailable` of kind `server`, `auth` or `resources`, and for `SearchNotReady`
 */
export function opensAtOnce(error: unknown): boolean {
  if (error instanceof SearchNotReady) return true;
  return (
    error instanceof SearchUnavailable &&
    (error.kind === 'server' || error.kind === 'auth' || error.kind === 'resources')
  );
}

/**
 * Decides whether the API may call the engine right now.
 *
 * Why: plan section 3.4 and decision 038 ("search never makes a page fail"): a broken engine must not add its timeout to every
 * keystroke. Closed: every call goes. Open: no call, until `openMs` passed; then half-open: exactly one call (the probe) goes, and its
 * outcome closes or re-opens the circuit. A probe that never reports back is replaced after another `openMs`.
 *
 * Side effects: none (in memory, per process); time comes from the injected clock (decision 031).
 */
export class SearchCircuit {
  private current: CircuitState = 'closed';
  private openedAt = 0;
  private probeStartedAt: number | null = null;
  private failures: number[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly options: SearchCircuitOptions = SEARCH_CIRCUIT_DEFAULTS,
  ) {}

  /**
   * Reads the state (moving an open circuit to half-open when its time is up).
   *
   * @returns the state
   */
  state(): CircuitState {
    if (this.current === 'open' && this.clock.nowMs() - this.openedAt >= this.options.openMs)
      this.current = 'half_open';
    return this.current;
  }

  /**
   * Asks to make one call.
   *
   * @returns true when the call may go (closed, or the half-open probe); false while open or while a probe is out
   */
  allow(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const now = this.clock.nowMs();
    if (this.probeStartedAt !== null && now - this.probeStartedAt < this.options.openMs) return false;
    this.probeStartedAt = now;
    return true;
  }

  /** Reports a call that succeeded: the circuit closes and forgets earlier failures. */
  succeeded(): void {
    this.current = 'closed';
    this.probeStartedAt = null;
    this.failures = [];
  }

  /**
   * Reports a call that failed.
   *
   * @param error what the call threw
   */
  failed(error: unknown): void {
    const now = this.clock.nowMs();
    if (this.current === 'half_open' || opensAtOnce(error)) {
      this.open(now);
      return;
    }
    this.failures = [...this.failures.filter((at) => now - at < this.options.windowMs), now];
    if (this.failures.length >= this.options.failureThreshold) this.open(now);
  }

  private open(now: number): void {
    this.current = 'open';
    this.openedAt = now;
    this.probeStartedAt = null;
    this.failures = [];
  }
}
