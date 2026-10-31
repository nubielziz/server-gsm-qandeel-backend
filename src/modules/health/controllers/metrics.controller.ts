// HTTP controller for GET /metrics (system surface): the Prometheus exposition of this process.
import { Controller, Header, UseGuards } from '@nestjs/common';
import { Route } from '../../../common/contract';
import { MetricsAccessGuard, MetricsService } from '../../../infra/metrics';
import { metricsContract } from '../contracts/health.contracts';

/**
 * Serves the Prometheus metrics of the API process.
 *
 * Why: Prometheus scrapes the API and the worker; access is the internal network or a bearer token (map rule).
 *
 * @route GET /metrics
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * @returns the exposition text
   * @throws {AppError} `FORBIDDEN` (403) from the guard when the caller is neither internal nor holds the token
   */
  @Route(metricsContract)
  @UseGuards(MetricsAccessGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.render();
  }
}
