// HTTP controller of the payment gateways (map domain E, stage 8, routes /admin/payment-gateways).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { PaymentGatewayService } from '../application/payment-gateway.service';
import { createGateway, deleteGateway, getGateway, listGateways, updateGateway } from '../contracts/gateways.contracts';

/**
 * Routes of the payment gateways.
 *
 * Why: thin layer over {@link PaymentGatewayService}: the contracts check access, CSRF and shapes; the service applies the rules.
 *
 * @route GET /admin/payment-gateways
 * @route GET /admin/payment-gateways/:id
 * @route POST /admin/payment-gateways
 * @route PATCH /admin/payment-gateways/:id
 * @route DELETE /admin/payment-gateways/:id
 */
@Controller()
export class GatewaysController {
  constructor(private readonly gateways: PaymentGatewayService) {}

  /**
   * Lists the gateways.
   *
   * @param query sort, range, filters and search
   * @returns the page of gateways
   * @route GET /admin/payment-gateways
   */
  @Route(listGateways)
  list(@Query() query: QueryOf<typeof listGateways>): Promise<ResultOf<typeof listGateways>> {
    return this.gateways.list(query);
  }

  /**
   * Reads one gateway.
   *
   * @param params the gateway id
   * @returns the gateway
   * @route GET /admin/payment-gateways/:id
   */
  @Route(getGateway)
  show(@Param() params: ParamsOf<typeof getGateway>): Promise<ResultOf<typeof getGateway>> {
    return this.gateways.get(params.id);
  }

  /**
   * Adds a gateway.
   *
   * @param body the new gateway
   * @returns the stored gateway
   * @route POST /admin/payment-gateways
   */
  @Route(createGateway)
  create(@Body() body: BodyOf<typeof createGateway>): Promise<ResultOf<typeof createGateway>> {
    return this.gateways.create(body);
  }

  /**
   * Changes a gateway.
   *
   * @param params the gateway id
   * @param body the fields to change
   * @returns the stored gateway
   * @route PATCH /admin/payment-gateways/:id
   */
  @Route(updateGateway)
  update(
    @Param() params: ParamsOf<typeof updateGateway>,
    @Body() body: BodyOf<typeof updateGateway>,
  ): Promise<ResultOf<typeof updateGateway>> {
    return this.gateways.update(params.id, body);
  }

  /**
   * Deletes a gateway nobody has paid through.
   *
   * @param params the gateway id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/payment-gateways/:id
   */
  @Route(deleteGateway)
  remove(@Param() params: ParamsOf<typeof deleteGateway>): Promise<void> {
    return this.gateways.remove(params.id);
  }
}
