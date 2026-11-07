// HTTP controller of the API traffic routes (map domain G, stage 9): metrics and errors read from Prometheus.
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { TrafficService } from '../application/traffic.service';
import { getApiErrors, getApiMetrics } from '../contracts/system-traffic.contracts';

/**
 * The API traffic routes.
 *
 * Why: the console's API tab charts the performance per surface and lists the most frequent errors.
 *
 * @route GET /admin/system/metrics
 * @route GET /admin/system/errors
 */
@Controller()
export class SystemTrafficController {
  constructor(private readonly traffic: TrafficService) {}

  /**
   * The API performance.
   *
   * @param query the range and an optional surface
   * @returns measures and series per surface
   * @route GET /admin/system/metrics
   */
  @Route(getApiMetrics)
  metrics(@Query() query: QueryOf<typeof getApiMetrics>): Promise<ResultOf<typeof getApiMetrics>> {
    return this.traffic.metrics(query.range, query.surface);
  }

  /**
   * The most frequent errors.
   *
   * @param query the range and an optional surface
   * @returns the top groups
   * @route GET /admin/system/errors
   */
  @Route(getApiErrors)
  errors(@Query() query: QueryOf<typeof getApiErrors>): Promise<ResultOf<typeof getApiErrors>> {
    return this.traffic.errors(query.range, query.surface);
  }
}
