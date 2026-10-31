// Runs the health indicators and folds their results into one status (decision 015).
// Never throws and never reveals versions, hostnames or error texts: details go to the log only.
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { type HealthIndicator, type HealthStatus, HealthRegistry } from './health-registry';

/** The answer of `GET /health`. */
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
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthService.name);
  }

  /**
   * Runs every indicator in parallel, each with a timeout.
   *
   * @returns the overall status and `ok`/`down` per indicator; `{ status: 'ok', checks: {} }` with no indicators
   * @see docs/contract/endpoints/health.md GET /health
   */
  async check(): Promise<HealthReport> {
    const results = await Promise.all(
      this.registry.list().map(async (indicator) => ({ indicator, up: await this.probe(indicator) })),
    );
    return {
      status: foldStatus(results),
      checks: Object.fromEntries(results.map((result) => [result.indicator.name, result.up ? 'ok' : 'down'])),
    };
  }

  private async probe(indicator: HealthIndicator): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
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
      clearTimeout(timer);
    }
  }
}
