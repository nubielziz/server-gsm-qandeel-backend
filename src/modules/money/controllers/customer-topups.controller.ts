// HTTP controller of the store balance top-ups of a retail account (feature 21, plan § 7.1 routes 3 to 8). Thin: it takes the account
// from the session and maps the inputs to the use case; every answer carries `Cache-Control: no-store`.
import { Body, Controller, Header, Param, Query, Res } from '@nestjs/common';
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
import { type AccountPrincipal, CurrentAccount } from '../../identity';
import { CustomerTopUps } from '../application/customer-top-ups';
import {
  attachMyTopUpReceipt,
  cancelMyTopUp,
  createMyTopUp,
  getMyTopUp,
  listMyTopUpMethods,
  listMyTopUps,
} from '../contracts/customer-topups.contracts';

/**
 * The top-up routes of the store.
 *
 * Why: the owner's customer wallet (ROADMAP 2W): a signed-in retail account tops up the store balance by a manual transfer (with a receipt)
 * or, while card top-ups are on, a gateway's hosted page. The account id is always the session's (plan § 5.1 invariant 5); a merchant rank
 * is refused with 403 `RANK_NOT_ALLOWED` by the rank gate of the `customer-session` access (decision 064).
 *
 * @route GET /store/v1/me/wallet/top-up-methods
 * @route POST /store/v1/me/wallet/top-ups
 * @route GET /store/v1/me/wallet/top-ups
 * @route GET /store/v1/me/wallet/top-ups/:id
 * @route POST /store/v1/me/wallet/top-ups/:id/receipt
 * @route POST /store/v1/me/wallet/top-ups/:id/cancel
 */
@Controller()
export class CustomerTopUpsController {
  constructor(private readonly topUps: CustomerTopUps) {}

  /**
   * The methods the account may top up through.
   *
   * @param query the parsed list request
   * @returns the methods and their number
   * @route GET /store/v1/me/wallet/top-up-methods
   */
  @Route(listMyTopUpMethods)
  @Header('Cache-Control', 'no-store')
  methods(@Query() query: QueryOf<typeof listMyTopUpMethods>): Promise<ResultOf<typeof listMyTopUpMethods>> {
    return this.topUps.methods(query);
  }

  /**
   * Starts a top-up.
   *
   * @param account the signed-in retail account
   * @param body the amount and the gateway
   * @param headers the required `Idempotency-Key`
   * @param reply the reply, for the replay marker
   * @returns the top-up with its instructions or payment page (`201`)
   * @route POST /store/v1/me/wallet/top-ups
   */
  @Route(createMyTopUp)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof createMyTopUp>,
    @ContractHeaders() headers: HeadersOf<typeof createMyTopUp>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof createMyTopUp>> {
    const created = await this.topUps.create(account.accountId, body, headers['idempotency-key']);
    if (created.replayed) reply.header('idempotency-replayed', 'true');
    return created.topUp;
  }

  /**
   * The account's store top-ups.
   *
   * @param account the signed-in retail account
   * @param query the parsed list request
   * @returns the page and the total
   * @route GET /store/v1/me/wallet/top-ups
   */
  @Route(listMyTopUps)
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listMyTopUps>,
  ): Promise<ResultOf<typeof listMyTopUps>> {
    return this.topUps.list(account.accountId, query);
  }

  /**
   * One of the account's store top-ups.
   *
   * @param account the signed-in retail account
   * @param params the top-up id
   * @returns the top-up with how to pay it
   * @route GET /store/v1/me/wallet/top-ups/:id
   */
  @Route(getMyTopUp)
  @Header('Cache-Control', 'no-store')
  show(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof getMyTopUp>,
  ): Promise<ResultOf<typeof getMyTopUp>> {
    return this.topUps.get(account.accountId, params.id);
  }

  /**
   * Attaches the transfer receipt.
   *
   * @param account the signed-in retail account
   * @param params the top-up id
   * @param body the receipt file and the bank reference
   * @param _headers the required `Idempotency-Key` (validated; the use case is idempotent by state)
   * @returns the top-up, in review (`201`)
   * @route POST /store/v1/me/wallet/top-ups/:id/receipt
   */
  @Route(attachMyTopUpReceipt)
  @Header('Cache-Control', 'no-store')
  receipt(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof attachMyTopUpReceipt>,
    @Body() body: BodyOf<typeof attachMyTopUpReceipt>,
    @ContractHeaders() _headers: HeadersOf<typeof attachMyTopUpReceipt>,
  ): Promise<ResultOf<typeof attachMyTopUpReceipt>> {
    return this.topUps.attachReceipt(account.accountId, params.id, body);
  }

  /**
   * Cancels a manual top-up without a receipt.
   *
   * @param account the signed-in retail account
   * @param params the top-up id
   * @param _headers the required `Idempotency-Key` (validated; the use case is idempotent by state)
   * @returns the cancelled top-up
   * @route POST /store/v1/me/wallet/top-ups/:id/cancel
   */
  @Route(cancelMyTopUp)
  @Header('Cache-Control', 'no-store')
  cancel(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof cancelMyTopUp>,
    @ContractHeaders() _headers: HeadersOf<typeof cancelMyTopUp>,
  ): Promise<ResultOf<typeof cancelMyTopUp>> {
    return this.topUps.cancel(account.accountId, params.id);
  }
}
