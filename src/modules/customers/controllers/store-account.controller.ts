// HTTP controller of the retail account's own routes (map domain I, /store/v1/me, stage 14; decision 064). Thin: the use cases are in
// CustomerAccountService.
import { Body, Controller, Header, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { type AccountPrincipal, CSRF_HEADER, CsrfService, CurrentAccount, requestMetaOf } from '../../identity';
import { CustomerAccountService } from '../application/customer-account.service';
import { getMe, listMyOrders, updateMe } from '../contracts/store-account.contracts';

/**
 * The retail account's own routes.
 *
 * Why: the account page shows the account's details (`AccountMe`, the same keys as `GET /client/auth/me`), lets it choose currency and
 * marketing consent, and lists its shop orders (map stage 14). Every route acts on the session's own account: no id comes from the request.
 * The routes serve the retail rank; a merchant rank reads its account and orders on the `/client` family.
 *
 * @route GET /store/v1/me
 * @route PATCH /store/v1/me
 * @route GET /store/v1/me/orders
 */
@Controller()
export class StoreAccountController {
  constructor(
    private readonly accounts: CustomerAccountService,
    private readonly csrf: CsrfService,
  ) {}

  /**
   * Describes the signed-in account.
   *
   * @param account the session's account
   * @param reply the reply, to repeat the CSRF token in `X-CSRF-Token`
   * @returns the account (`AccountMe`)
   * @route GET /store/v1/me
   */
  @Route(getMe)
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentAccount() account: AccountPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof getMe>> {
    const me = await this.accounts.me(account);
    // After a reload a cross-site storefront can only recover the token from a response header.
    void reply.header(CSRF_HEADER, this.csrf.tokenFor(account.session.tokenHash));
    return me;
  }

  /**
   * Changes name, phone, country, currency and marketing consent.
   *
   * @param account the session's account
   * @param body the fields to change
   * @param request the request (its address and user agent go into a consent record)
   * @returns the account after the change
   * @route PATCH /store/v1/me
   */
  @Route(updateMe)
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof updateMe>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof updateMe>> {
    return this.accounts.updateMe(account, body, requestMetaOf(request));
  }

  /**
   * Lists the account's own shop orders.
   *
   * @param account the session's account
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /store/v1/me/orders
   */
  @Route(listMyOrders)
  orders(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listMyOrders>,
  ): Promise<ResultOf<typeof listMyOrders>> {
    return this.accounts.orders(account, query);
  }
}
