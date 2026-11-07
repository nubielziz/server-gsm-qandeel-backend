// HTTP controller of the orders over REST v1 (map domain D, stage 7): place, bulk, list, show, cancel and verify for the merchant behind the
// API key. Thin: the rules are ApiOrdersService (and feature 5's placement and transitions behind it).
import { Body, Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  type BodyOf,
  ContractHeaders,
  type HeadersOf,
  type ParamsOf,
  type QueryOf,
  type ResultOf,
  Route,
} from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type ApiKeyPrincipal, CurrentPrincipal, type Principal } from '../../identity';
import { type ApiCaller, ApiOrdersService, type ApiPlaced } from '../application/api-orders.service';
import {
  cancelV1Order,
  listV1Orders,
  placeV1Order,
  placeV1OrdersBulk,
  showV1Order,
  verifyV1Order,
} from '../contracts/v1-orders.contracts';

/** The merchant and the key behind an API-key call. */
function callerOf(principal: Principal | undefined): ApiCaller {
  if (principal?.kind !== 'api-key') throw new AppError('UNAUTHORIZED');
  const key: ApiKeyPrincipal = principal;
  return { clientId: key.clientId, keyId: key.keyId };
}

/** Marks an answer that was stored by an earlier request with the same `Idempotency-Key` (nothing was placed this time). */
function markReplay(reply: FastifyReply, placed: ApiPlaced): void {
  if (placed.replayed) void reply.header('idempotency-replayed', 'true');
}

/**
 * The order routes of REST v1.
 *
 * Why: an integration places, follows, cancels and verifies orders with its API key (scopes `orders:write` and `orders:read`); the
 * answers are the merchant's order of the portal, with the statuses of the console. `Idempotency-Key` on the two placements makes a
 * retry safe (ALIGNMENT § 7).
 *
 * @route POST /v1/orders
 * @route POST /v1/orders/bulk
 * @route GET /v1/orders
 * @route GET /v1/orders/:id
 * @route POST /v1/orders/:id/cancel
 * @route POST /v1/orders/:id/verify
 */
@Controller()
export class V1OrdersController {
  constructor(private readonly orders: ApiOrdersService) {}

  /**
   * Places an order.
   *
   * @param principal the API-key principal
   * @param body the order
   * @param headers the optional `Idempotency-Key`
   * @param reply the reply, to mark a replay
   * @returns the order (`201`)
   * @route POST /v1/orders
   */
  @Route(placeV1Order)
  async place(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof placeV1Order>,
    @ContractHeaders() headers: HeadersOf<typeof placeV1Order>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof placeV1Order>> {
    const placed = await this.orders.place(callerOf(principal), body, headers['idempotency-key']);
    markReplay(reply, placed);
    return placed.body as ResultOf<typeof placeV1Order>;
  }

  /**
   * Places several orders, answered one by one.
   *
   * @param principal the API-key principal
   * @param body the orders
   * @param headers the optional `Idempotency-Key`
   * @param reply the reply, to mark a replay
   * @returns one result per order
   * @route POST /v1/orders/bulk
   */
  @Route(placeV1OrdersBulk)
  async placeBulk(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof placeV1OrdersBulk>,
    @ContractHeaders() headers: HeadersOf<typeof placeV1OrdersBulk>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof placeV1OrdersBulk>> {
    const placed = await this.orders.placeBulk(callerOf(principal), body.orders, headers['idempotency-key']);
    markReplay(reply, placed);
    return placed.body as ResultOf<typeof placeV1OrdersBulk>;
  }

  /**
   * Lists a page of the merchant's orders.
   *
   * @param principal the API-key principal
   * @param query the page size, cursor and filters
   * @returns the orders and the next cursor
   * @route GET /v1/orders
   */
  @Route(listV1Orders)
  list(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listV1Orders>,
  ): Promise<ResultOf<typeof listV1Orders>> {
    return this.orders.list(callerOf(principal).clientId, query);
  }

  /**
   * Shows one order.
   *
   * @param principal the API-key principal
   * @param params the order id
   * @returns the order
   * @route GET /v1/orders/:id
   */
  @Route(showV1Order)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof showV1Order>,
  ): Promise<ResultOf<typeof showV1Order>> {
    return this.orders.show(callerOf(principal).clientId, params.id);
  }

  /**
   * Cancels an order that was never sent.
   *
   * @param principal the API-key principal
   * @param params the order id
   * @returns the order after the cancellation
   * @route POST /v1/orders/:id/cancel
   */
  @Route(cancelV1Order)
  cancel(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof cancelV1Order>,
  ): Promise<ResultOf<typeof cancelV1Order>> {
    return this.orders.cancel(callerOf(principal).clientId, params.id);
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param principal the API-key principal
   * @param params the order id
   * @returns the order after the request
   * @route POST /v1/orders/:id/verify
   */
  @Route(verifyV1Order)
  verify(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof verifyV1Order>,
  ): Promise<ResultOf<typeof verifyV1Order>> {
    return this.orders.verify(callerOf(principal).clientId, params.id);
  }
}
