// HTTP controller of `GET /admin/dashboard` (map domain G, stage 9). Thin: the read model is built by DashboardService.
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { getDashboard } from './dashboard.contracts';
import { DashboardService } from './dashboard.service';

/**
 * The dashboard route.
 *
 * Why: the console's Dashboard page and the sidebar counts read this one object.
 *
 * @route GET /admin/dashboard
 */
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Builds the dashboard.
   *
   * @param query the scope and the number of days
   * @returns the read model
   * @route GET /admin/dashboard
   */
  @Route(getDashboard)
  show(@Query() query: QueryOf<typeof getDashboard>): Promise<ResultOf<typeof getDashboard>> {
    return this.dashboard.get(query.scope, query.days) as Promise<ResultOf<typeof getDashboard>>;
  }
}
