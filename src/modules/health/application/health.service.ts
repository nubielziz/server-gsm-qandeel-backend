// Runs the health indicators and folds their results into one status (decision 015).
// Never throws and never reveals versions, hostnames or error texts: details go to the log only.
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock, TIMERS, type Timers } from '../../../common/clock';
import { ShortMemo } from '../../../common/short-memo';
import { type HealthIndicator, type HealthStatus, HealthRegistry } from '../../../infra/health';

/**
 * The answer of `GET /health`.
 *
 * Why: the console reads `{ status, checks }` and nothing internal (map B11).
 */
export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: Record<string, 'ok' | 'down'>;
}

/**
 * Longest an indicator may take before it counts as down.
 *
 * Why: the console polls `/health` and must always get an answer, even when a dependency hangs.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * How long a health answer is reused, in milliseconds.
 *
 * Why: decision 053. `GET /health` is public; every call used to run every indicator (a Postgres query, two Redis pings, a storage call), so
 * a caller could multiply the work on the dependencies. One check runs at a time and its answer serves every caller for 3 seconds.
 */
export const HEALTH_MEMO_MS = 3000;

/**
 * Combines indicator results: any critical indicator down is `down`, otherwise any non-critical one down is `degraded`.
 *
 * Why: decision 015 / map B11: Postgres failing is `down`, a Redis role failing is `degraded`.
 *
 * @param results each indicator with whether it is up
 * @returns the overall status
 */
export function foldStatus(
  results: ReadonlyArray<{ indicator: Pick<HealthIndicator, 'critical'>; up: boolean }>,
): HealthStatus {
  if (results.some((result) => !result.up && result.indicator.critical)) return 'down';
  return results.some((result) => !result.up) ? 'degraded' : 'ok';
}

/**
 * Evaluates the health of the process.
 *
 * Why: the console polls `/health` once a minute per tab and treats anything but a 2xx JSON as "API unreachable", so
 * the check must stay cheap, bounded in time, and answer even when a dependency hangs (map GET /health, B11).
 *
 * Decision 053: the answer comes from a {@link ShortMemo} of {@link HEALTH_MEMO_MS} on the injected clock, one check at a time, so an
 * unauthenticated probe cannot multiply the work on the dependencies; a caller can see a result up to 3 seconds old.
 */
@Injectable()
export class HealthService {
  private readonly memo: ShortMemo<HealthReport>;

  constructor(
    private readonly registry: HealthRegistry,
    private readonly logger: PinoLogger,
    @Inject(TIMERS) private readonly timers: Timers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(HealthService.name);
    this.memo = new ShortMemo<HealthReport>({ ttlMs: HEALTH_MEMO_MS, now: () => this.clock.nowMs() });
  }

  /**
   * Answers the health of the process from a check at most 3 seconds old.
   *
   * Why: decision 053; see the class. `?strict=1` reads the same memo and only changes the status code.
   *
   * Side effects: runs {@link HealthService.checkNow} when the memo is older than {@link HEALTH_MEMO_MS}; concurrent callers share one run.
   *
   * @returns the overall status and `ok`/`down` per indicator; `{ status: 'ok', checks: {} }` with no indicators
   * @see docs/contract/endpoints/health.md GET /health
   */
  check(): Promise<HealthReport> {
    return this.memo.get(() => this.checkNow());
  }

  /**
   * Runs every indicator in parallel, each with a timeout.
   *
   * @returns the overall status and `ok`/`down` per indicator; `{ status: 'ok', checks: {} }` with no indicators
   */
  private async checkNow(): Promise<HealthReport> {
    const results = await Promise.all(
      this.registry.list().map(async (indicator) => ({ indicator, up: await this.probe(indicator) })),
    );
    return {
      status: foldStatus(results),
      checks: Object.fromEntries(results.map((result) => [result.indicator.name, result.up ? 'ok' : 'down'])),
    };
  }

  private async probe(indicator: HealthIndicator): Promise<boolean> {
    let timer: unknown;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = this.timers.setTimeout(
          () => reject(new Error(`timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms`)),
          HEALTH_CHECK_TIMEOUT_MS,
        );
      });
      return (await Promise.race([indicator.check(), timeout])) !== false;
    } catch (error) {
      // The reason stays in the log; the response only says "down".
      this.logger.warn(
        { err: error, indicator: indicator.name, critical: indicator.critical },
        'Health indicator is down',
      );
      return false;
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
    }
  }
}
