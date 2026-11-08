// HTTP controller of the storefront customer's account routes (map domain I, /store/v1/me, stage 14). Thin: the use cases are
// in CustomerAccountService.
import { Body, Controller, Header, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CSRF_HEADER, CsrfService, type CustomerPrincipal, requestMetaOf } from '../../identity';
import { CustomerAccountService } from '../application/customer-account.service';
import { getMe, listMyOrders, updateMe } from '../contracts/store-account.contracts';
import { CurrentCustomer } from './current-customer';

/**
 * The storefront customer's account routes.
 *
 * Why: the account page shows the customer's details, lets them choose language, currency and marketing consent, and lists
 * their orders (map stage 14). Every route acts on the session's own customer: no id comes from the request.
 *
 * @route GET /store/v1/me
 * @route PATCH /store/v1/me
 * @route GET /store/v1/me/orders
 */
@Controller()
export class StoreAccountController {
  constructor(
    private readonly account: CustomerAccountService,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Describes the signed-in customer.
   *
   * @param customer the session's customer
   * @param reply the reply, to repeat the CSRF token in `X-CSRF-Token`
   * @returns the account
   * @route GET /store/v1/me
   */
  @Route(getMe)
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof getMe>> {
    const me = await this.account.me(customer);
    // After a reload a cross-site storefront can only recover the token from a response header.
    void reply.header(CSRF_HEADER, this.csrf.tokenFor(customer.session.tokenHash));
    return me;
  }

  /**
   * Changes language, currency and marketing consent.
   *
   * @param customer the session's customer
   * @param body the fields to change
   * @param request the request (its address and user agent go into a consent record)
   * @returns the account after the change
   * @route PATCH /store/v1/me
   */
  @Route(updateMe)
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() body: BodyOf<typeof updateMe>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof updateMe>> {
    return this.account.updateMe(customer, body, requestMetaOf(request));
  }

  /**
   * Lists the customer's own orders.
   *
   * @param customer the session's customer
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /store/v1/me/orders
   */
  @Route(listMyOrders)
  orders(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Query() query: QueryOf<typeof listMyOrders>,
  ): Promise<ResultOf<typeof listMyOrders>> {
    return this.account.orders(customer, query);
  }
}
