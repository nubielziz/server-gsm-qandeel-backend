// HTTP controller of the client price routes (map domain B, /admin/client-prices, stage 4). Thin: the rules live in
// ClientPriceAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { ClientPriceAdminService } from '../application/client-price-admin.service';
import {
  createClientPrice,
  deleteClientPrice,
  listClientPrices,
  updateClientPrice,
} from '../contracts/client-prices.contracts';

/**
 * The client price routes.
 *
 * Why: staff agree a fixed price with one merchant for one service; it beats the group price and every rule.
 *
 * @route GET /admin/client-prices
 * @route POST /admin/client-prices
 * @route PATCH /admin/client-prices/:id
 * @route DELETE /admin/client-prices/:id
 */
@Controller()
export class ClientPricesController {
  constructor(private readonly prices: ClientPriceAdminService) {}

  /**
   * Lists client prices.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/client-prices
   */
  @Route(listClientPrices)
  list(@Query() query: QueryOf<typeof listClientPrices>): Promise<ResultOf<typeof listClientPrices>> {
    return this.prices.list(query);
  }

  /**
   * Sets a client price.
   *
   * @param staff the signed-in staff member (`created_by`)
   * @param body merchant, service, price and note
   * @returns the new price
   * @route POST /admin/client-prices
   */
  @Route(createClientPrice)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createClientPrice>,
  ): Promise<ResultOf<typeof createClientPrice>> {
    return this.prices.create(body, staff.staffId);
  }

  /**
   * Changes a client price.
   *
   * @param params the client price id
   * @param body the keys to change
   * @returns the updated price
   * @route PATCH /admin/client-prices/:id
   */
  @Route(updateClientPrice)
  update(
    @Param() params: ParamsOf<typeof updateClientPrice>,
    @Body() body: BodyOf<typeof updateClientPrice>,
  ): Promise<ResultOf<typeof updateClientPrice>> {
    return this.prices.update(params.id, body);
  }

  /**
   * Removes a client price.
   *
   * @param params the client price id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/client-prices/:id
   */
  @Route(deleteClientPrice)
  remove(@Param() params: ParamsOf<typeof deleteClientPrice>): Promise<void> {
    return this.prices.remove(params.id);
  }
}
