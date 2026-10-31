// HTTP controller for GET /health (system surface). Thin: the check is in HealthService, the contract in contracts/.
import { Controller, Header, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route, respondWith } from '../../../common/contract';
import { HealthService } from '../application/health.service';
import { healthContract } from '../contracts/health.contracts';

/**
 * Serves the service health check.
 *
 * Why: see {@link healthContract}. Public, uncached, cheap.
 *
 * @route GET /health
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Runs the registered health checks and reports the overall status.
   *
   * @param query `strict`: answer 503 when the status is `down` (a critical dependency failed)
   * @returns `{ status, checks }`
   * @throws {AlternateResponse} 503 with the same body, only with `?strict=1` and the status `down`; `degraded` stays 200
   *   because the API still serves without a non-critical dependency (cache, queue Redis, storage)
   */
  @Route(healthContract)
  @Header('Cache-Control', 'no-store')
  async show(@Query() query: QueryOf<typeof healthContract>): Promise<ResultOf<typeof healthContract>> {
    const report = await this.health.check();
    if (query.strict && report.status === 'down') throw respondWith(healthContract, 503, report);
    return report;
  }
}
