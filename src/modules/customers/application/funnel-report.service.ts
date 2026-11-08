// FunnelReportService: the use case of `GET /admin/reports/funnel` (feature 19, resolution b2c-10): the storefront funnel over 7, 30 or 90 days.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ResultOf } from '../../../common/contract';
import { DbService } from '../../../infra/db';
import type { getFunnel } from '../contracts/growth.contracts';
import { storefrontFunnel } from '../storefront-funnel';

/**
 * Reads the sales funnel for the Checkouts page.
 *
 * Why: b2c-10 and M39: the page and the dashboard's storefront block count with the one function `storefrontFunnel`, so their numbers
 * agree; this route only chooses the window (`[now - days x 24 h, now)` on the injected clock, the end exclusive) and drops the dashboard's visitor estimate.
 *
 * Side effects: none (reads `imei_checks`, `checkout_sessions` and `orders`).
 */
@Injectable()
export class FunnelReportService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts the funnel.
   *
   * @param days 7, 30 or 90 (the contract refuses anything else)
   * @returns the period and the four counts
   */
  async report(days: number): Promise<ResultOf<typeof getFunnel>> {
    const { imeiChecks, paymentStarted, paid, delivered } = await storefrontFunnel(this.db.db, this.clock.now(), days);
    return { days, imeiChecks, paymentStarted, paid, delivered };
  }
}
