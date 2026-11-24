// HTTP controller of the funnel report of the customers module (map stage 19): the storefront sales funnel. Thin: the rules live in the service.
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { FunnelReportService } from '../application/funnel-report.service';
import { getFunnel } from '../contracts/growth.contracts';

/**
 * The funnel report route.
 *
 * Why: staff read the storefront funnel: how many checkouts were started, paid and delivered.
 *
 * @route GET /admin/reports/funnel
 */
@Controller()
export class GrowthController {
  constructor(private readonly funnelReport: FunnelReportService) {}

  /**
   * Reads the sales funnel.
   *
   * @param query the period
   * @returns the four counts
   * @route GET /admin/reports/funnel
   */
  @Route(getFunnel)
  funnel(@Query() query: QueryOf<typeof getFunnel>): Promise<ResultOf<typeof getFunnel>> {
    return this.funnelReport.report(query.days);
  }
}
