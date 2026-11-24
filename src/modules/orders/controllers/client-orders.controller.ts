// HTTP controller of the merchant portal's orders (map domain D, stage 5): dashboard, place, list, show, cancel, verify and export.
// Thin: the rules live in ClientOrdersService, OrderReadService and OrderExportService.
import { Body, Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import {
  type BodyOf,
  ContractHeaders,
  type HeadersOf,
  type ParamsOf,
  type QueryOf,
  type ResultOf,
  Route,
} from '../../../common/contract';
import { type AccountPrincipal, CurrentAccount } from '../../identity';
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
 * Why: the merchant orders, follows and exports its own orders (map stage 5); a retail rank is refused by the rank gate (`403
 * RANK_NOT_ALLOWED`, decision 064) and an account never reaches another's order, or its own store order (`404`).
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
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @returns the wallet, the counts and the latest orders
   * @route GET /client/dashboard
   */
  @Route(getMyDashboard)
  dashboard(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof getMyDashboard>> {
    return this.reads.dashboard(account.accountId);
  }

  /**
   * Places an order, or a bulk of IMEIs.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param body the service and what to order
   * @param headers the optional `Idempotency-Key`
   * @param reply the reply, to mark a replay
   * @returns the placed orders (`201`), or the stored answer of an earlier request with the same key
   * @route POST /client/orders
   */
  @Route(placeClientOrder)
  async place(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof placeClientOrder>,
    @ContractHeaders() headers: HeadersOf<typeof placeClientOrder>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof placeClientOrder>> {
    const placed = await this.orders.place(account.accountId, body, 'portal', headers['idempotency-key']);
    if (placed.replayed) void reply.header('idempotency-replayed', 'true');
    return { orders: placed.orders };
  }

  /**
   * Lists the merchant's orders.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param query the parsed list request
   * @returns the rows and the exact total
   * @route GET /client/orders
   */
  @Route(listClientOrders)
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listClientOrders>,
  ): Promise<ResultOf<typeof listClientOrders>> {
    return this.reads.listForMerchant(account.accountId, query);
  }

  /**
   * Exports the merchant's orders as a CSV file.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param query the parsed list request (the range is ignored)
   * @param reply the reply, for the file headers
   * @returns the CSV as a stream
   * @route GET /client/orders/export
   */
  @Route(exportClientOrders)
  async export(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof exportClientOrders>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Readable> {
    const file = await this.exports.forMerchant(account.accountId, query);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="orders.csv"')
      .header('cache-control', 'no-store');
    return file.stream;
  }

  /**
   * Shows one of the merchant's orders with its timeline.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param params the order id
   * @returns the order and its visible timeline
   * @route GET /client/orders/:id
   */
  @Route(showClientOrder)
  show(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof showClientOrder>,
  ): Promise<ResultOf<typeof showClientOrder>> {
    return this.reads.showForMerchant(account.accountId, params.id);
  }

  /**
   * Cancels an order that was never sent.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /client/orders/:id/cancel
   */
  @Route(cancelClientOrder)
  cancel(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof cancelClientOrder>,
  ): Promise<void> {
    return this.orders.cancel(account.accountId, params.id);
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param account the signed-in account (a merchant rank; the rank gate refuses every other)
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /client/orders/:id/verify
   */
  @Route(verifyClientOrder)
  verify(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof verifyClientOrder>,
  ): Promise<void> {
    return this.orders.verify(account.accountId, params.id);
  }
}
