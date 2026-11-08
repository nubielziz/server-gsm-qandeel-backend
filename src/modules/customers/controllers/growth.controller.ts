// HTTP controller of the growth pages of the customers module (map stage 19): the abandoned checkouts, the recovery send and the sales
// funnel. Thin: the rules live in the services.
import { Body, Controller, Query } from '@nestjs/common';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AbandonedCheckoutsService } from '../application/abandoned-checkouts.service';
import { CheckoutRecoveryService } from '../application/checkout-recovery.service';
import { FunnelReportService } from '../application/funnel-report.service';
import { getFunnel, listAbandonedCheckouts, recoverCheckouts } from '../contracts/growth.contracts';

/**
 * The Checkouts page routes.
 *
 * Why: staff see who left a checkout, remind the ones who agreed to marketing email, and read the storefront funnel.
 *
 * @route GET /admin/checkouts/abandoned
 * @route POST /admin/checkouts/recover
 * @route GET /admin/reports/funnel
 */
@Controller()
export class GrowthController {
  constructor(
    private readonly abandoned: AbandonedCheckoutsService,
    private readonly recovery: CheckoutRecoveryService,
    private readonly funnelReport: FunnelReportService,
  ) {}

  /**
   * Lists abandoned checkouts.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/checkouts/abandoned
   */
  @Route(listAbandonedCheckouts)
  list(@Query() query: QueryOf<typeof listAbandonedCheckouts>): Promise<ResultOf<typeof listAbandonedCheckouts>> {
    return this.abandoned.list(query);
  }

  /**
   * Queues recovery emails.
   *
   * @param body the ticked checkout ids
   * @returns how many emails were queued and which checkouts were left out
   * @route POST /admin/checkouts/recover
   */
  @Route(recoverCheckouts)
  recover(@Body() body: BodyOf<typeof recoverCheckouts>): Promise<ResultOf<typeof recoverCheckouts>> {
    return this.recovery.recover(body.ids);
  }

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
