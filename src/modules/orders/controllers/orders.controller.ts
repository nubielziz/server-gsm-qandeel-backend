// HTTP controller of the admin order reads (map domain D, stage 5): list, one order, timeline and the CSV export. Thin: the rules live
// in OrderReadService and OrderExportService.
import { Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { OrderExportService } from '../application/order-export.service';
import { OrderReadService } from '../application/order-read.service';
import { exportOrders, listOrderEvents, listOrders, showOrder } from '../contracts/orders.contracts';

/**
 * The admin order read routes.
 *
 * Why: the console's Orders page, the order drawer, the palette and the deep links read these; the answers are never cached because
 * staff decide on the order status (decision 022).
 *
 * @route GET /admin/orders
 * @route GET /admin/orders/export
 * @route GET /admin/orders/:id
 * @route GET /admin/orders/:id/events
 */
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrderReadService,
    private readonly exports: OrderExportService,
  ) {}

  /**
   * Lists a page of orders.
   *
   * @param query the parsed list request
   * @returns the rows and the exact total
   * @route GET /admin/orders
   */
  @Route(listOrders)
  list(@Query() query: QueryOf<typeof listOrders>): Promise<ResultOf<typeof listOrders>> {
    return this.orders.listForStaff(query);
  }

  /**
   * Exports the matching orders as a CSV file.
   *
   * @param query the parsed list request (the range is ignored)
   * @param reply the reply, for the file headers
   * @returns the CSV as a stream
   * @route GET /admin/orders/export
   */
  @Route(exportOrders)
  async export(
    @Query() query: QueryOf<typeof exportOrders>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Readable> {
    const file = await this.exports.forStaff(query);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="orders-export.csv"')
      .header('cache-control', 'no-store');
    return file.stream;
  }

  /**
   * Shows one order.
   *
   * @param params the order id
   * @returns the order
   * @route GET /admin/orders/:id
   */
  @Route(showOrder)
  show(@Param() params: ParamsOf<typeof showOrder>): Promise<ResultOf<typeof showOrder>> {
    return this.orders.showForStaff(params.id);
  }

  /**
   * Reads the timeline of an order.
   *
   * @param params the order id
   * @returns the events, oldest first
   * @route GET /admin/orders/:id/events
   */
  @Route(listOrderEvents)
  events(@Param() params: ParamsOf<typeof listOrderEvents>): Promise<ResultOf<typeof listOrderEvents>> {
    return this.orders.eventsForStaff(params.id);
  }
}
