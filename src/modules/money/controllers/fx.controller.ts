// HTTP controller of the exchange-rate refresh (map domain E, stage 14, route POST /admin/currencies/refresh-fx).
import { Controller } from '@nestjs/common';
import { type ResultOf, Route } from '../../../common/contract';
import { FxRefreshService } from '../application/fx-refresh.service';
import { refreshFx } from '../contracts/fx.contracts';

/**
 * The refresh button of the console's Settings page.
 *
 * Why: staff ask the server for fresh rates for the currencies shown to customers (RULES settings, money-9).
 *
 * @route POST /admin/currencies/refresh-fx
 */
@Controller()
export class FxController {
  constructor(private readonly fx: FxRefreshService) {}

  /**
   * Refreshes the exchange rates.
   *
   * @returns what was refreshed, what failed and the provider's name
   * @route POST /admin/currencies/refresh-fx
   */
  @Route(refreshFx)
  refresh(): Promise<ResultOf<typeof refreshFx>> {
    return this.fx.refresh();
  }
}
