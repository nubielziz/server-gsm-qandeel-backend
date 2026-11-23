// HTTP controller of the console's service page routes beyond the map (decision 063): the price grid and the stored order of services.
// Thin: the rules live in ServicePriceGridService and ServiceOrderService.
import { Body, Controller, Query } from '@nestjs/common';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { ServiceOrderService } from '../application/service-order.service';
import { ServicePriceGridService } from '../application/service-price-grid.service';
import { listServicePriceGrid, orderServices } from '../contracts/service-grid.contracts';

/**
 * The price grid and the order of services.
 *
 * Why: the console's service page prices many services at once and lets staff put them in the order merchants see; no existing route
 * read the group prices of many services or stored a position of a service (decision 063).
 *
 * @route GET /admin/services/price-grid
 * @route POST /admin/services/order
 */
@Controller()
export class ServiceGridController {
  constructor(
    private readonly grid: ServicePriceGridService,
    private readonly order: ServiceOrderService,
  ) {}

  /**
   * Reads one page of the price grid.
   *
   * @param staff the signed-in staff member (the grid also needs `pricing:read`)
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/services/price-grid
   */
  @Route(listServicePriceGrid)
  list(
    @CurrentStaff() staff: StaffPrincipal,
    @Query() query: QueryOf<typeof listServicePriceGrid>,
  ): Promise<ResultOf<typeof listServicePriceGrid>> {
    return this.grid.list(staff, query);
  }

  /**
   * Sets the position of services.
   *
   * @param body the services and their positions
   * @returns how many services changed position
   * @route POST /admin/services/order
   */
  @Route(orderServices)
  setOrder(@Body() body: BodyOf<typeof orderServices>): Promise<ResultOf<typeof orderServices>> {
    return this.order.apply(body.items);
  }
}
