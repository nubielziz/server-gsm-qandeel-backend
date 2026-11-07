// HTTP controller of the merchant's account over REST v1 (map domain E, stage 7): the wallet and the statement of the API key's merchant.
// Thin: the reads are MerchantApiAccount.
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type Principal } from '../../identity';
import { MerchantApiAccount } from '../application/merchant-api-account';
import { getV1Account, listV1Transactions } from '../contracts/v1-account.contracts';

/** The merchant behind an API key. */
function merchantIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'api-key') throw new AppError('UNAUTHORIZED');
  return principal.clientId;
}

/**
 * The account routes of REST v1.
 *
 * Why: an integration reads the balance it may spend and its statement with its API key (scope `account:read`); the figures come
 * straight from the ledger, like the portal's.
 *
 * @route GET /v1/account
 * @route GET /v1/transactions
 */
@Controller()
export class V1AccountController {
  constructor(private readonly account: MerchantApiAccount) {}

  /**
   * The wallet and group of the merchant behind the key.
   *
   * @param principal the API-key principal
   * @returns the wallet figures, the currency and the group
   * @route GET /v1/account
   */
  @Route(getV1Account)
  show(@CurrentPrincipal() principal: Principal | undefined): Promise<ResultOf<typeof getV1Account>> {
    return this.account.account(merchantIdOf(principal));
  }

  /**
   * A page of the statement of the merchant behind the key.
   *
   * @param principal the API-key principal
   * @param query the page size and cursor
   * @returns the lines and the next cursor
   * @route GET /v1/transactions
   */
  @Route(listV1Transactions)
  transactions(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listV1Transactions>,
  ): Promise<ResultOf<typeof listV1Transactions>> {
    return this.account.transactions(merchantIdOf(principal), query);
  }
}
