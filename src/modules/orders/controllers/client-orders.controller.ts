// HTTP controller of the merchant portal's orders (map domain D, stage 5): dashboard, place, list, show, cancel, verify and export.
// Thin: the rules live in ClientOrdersService, OrderReadService and OrderExportService.
import { Body, Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentMerchant, type MerchantPrincipal } from '../../identity';
import { ClientOrdersService } from '../application/client-orders.service';
import { OrderExportService } from '../application/order-export.service';
import { OrderReadService } from '../application/order-read.service';
import {
  cancelClientOrder,
  exportClientOrders,
  getMyDashboard,
  listClientOrders,
  placeClientOrder,
  showClientOrder,
  verifyClientOrder,
} from '../contracts/client-orders.contracts';

/**
 * The merchant portal order routes.
 *
 * Why: the merchant orders, follows and exports its own orders (map stage 5); a pending merchant is refused by the guard (B153) and a
 * merchant never reaches another's order (`404`).
 *
 * @route GET /client/dashboard
 * @route POST /client/orders
 * @route GET /client/orders
 * @route GET /client/orders/export
 * @route GET /client/orders/:id
 * @route POST /client/orders/:id/cancel
 * @route POST /client/orders/:id/verify
 */
@Controller()
export class ClientOrdersController {
  constructor(
    private readonly reads: OrderReadService,
    private readonly orders: ClientOrdersService,
    private readonly exports: OrderExportService,
  ) {}

  /**
   * The merchant's dashboard.
   *
   * @param merchant the signed-in merchant
   * @returns the wallet, the counts and the latest orders
   * @route GET /client/dashboard
   */
  @Route(getMyDashboard)
  dashboard(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof getMyDashboard>> {
    return this.reads.dashboard(merchant.clientId);
  }

  /**
   * Places an order, or a bulk of IMEIs.
   *
   * @param merchant the signed-in merchant
   * @param body the service and what to order
   * @returns the placed orders
   * @route POST /client/orders
   */
  @Route(placeClientOrder)
  async place(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof placeClientOrder>,
  ): Promise<ResultOf<typeof placeClientOrder>> {
    return { orders: await this.orders.place(merchant.clientId, body) };
  }

  /**
   * Lists the merchant's orders.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed list request
   * @returns the rows and the exact total
   * @route GET /client/orders
   */
  @Route(listClientOrders)
  list(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof listClientOrders>,
  ): Promise<ResultOf<typeof listClientOrders>> {
    return this.reads.listForMerchant(merchant.clientId, query);
  }

  /**
   * Exports the merchant's orders as a CSV file.
   *
   * @param merchant the signed-in merchant
   * @param query the parsed list request (the range is ignored)
   * @param reply the reply, for the file headers
   * @returns the CSV as a stream
   * @route GET /client/orders/export
   */
  @Route(exportClientOrders)
  async export(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof exportClientOrders>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Readable> {
    const file = await this.exports.forMerchant(merchant.clientId, query);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="orders.csv"')
      .header('cache-control', 'no-store');
    return file.stream;
  }

  /**
   * Shows one of the merchant's orders with its timeline.
   *
   * @param merchant the signed-in merchant
   * @param params the order id
   * @returns the order and its visible timeline
   * @route GET /client/orders/:id
   */
  @Route(showClientOrder)
  show(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof showClientOrder>,
  ): Promise<ResultOf<typeof showClientOrder>> {
    return this.reads.showForMerchant(merchant.clientId, params.id);
  }

  /**
   * Cancels an order that was never sent.
   *
   * @param merchant the signed-in merchant
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /client/orders/:id/cancel
   */
  @Route(cancelClientOrder)
  cancel(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof cancelClientOrder>,
  ): Promise<void> {
    return this.orders.cancel(merchant.clientId, params.id);
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param merchant the signed-in merchant
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /client/orders/:id/verify
   */
  @Route(verifyClientOrder)
  verify(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof verifyClientOrder>,
  ): Promise<void> {
    return this.orders.verify(merchant.clientId, params.id);
  }
}
