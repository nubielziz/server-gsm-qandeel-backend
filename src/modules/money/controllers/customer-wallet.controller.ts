// HTTP controller of the store balance of an account (feature 21, plan § 7.1 routes 1, 2 and 11 to 16, decision 064): the signed-in retail
// account's own wallet and statement on the store, the staff list of store wallets, and the five retired staff wallet routes of
// `/admin/customers/:id`, which answer 410 until the contract release deletes them. Thin: it maps inputs to the use case.
import { Controller, Header, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, CurrentStaff, type Principal, type StaffPrincipal, customerContactOf } from '../../identity';
import { CustomerWallets } from '../application/customer-wallets';
import {
  adjustCustomerWallet,
  freezeCustomerWallet,
  getCustomerWallet,
  getMyStoreWallet,
  listCustomerWalletStatement,
  listCustomerWallets,
  listMyStoreWalletStatement,
  unfreezeCustomerWallet,
} from '../contracts/customer-wallet.contracts';

/**
 * The retail account behind a store session.
 *
 * Why: plan 21 § 5.1 invariant 5: every account id comes from the authenticated principal, never from the request (money cannot import the
 * customers module's decorators, decision 032). The rank gate already refuses a merchant rank on a store route with `403 RANK_NOT_ALLOWED`
 * before a handler runs; this check keeps the wallet closed to a merchant rank even if a route were ever marked open to every rank.
 *
 * @param principal the request's principal
 * @returns the account id
 * @throws {AppError} `UNAUTHORIZED` when the request was not authenticated as an account, `RANK_NOT_ALLOWED` (403) for a merchant rank
 */
export function accountIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'account') throw new AppError('UNAUTHORIZED');
  if (principal.rank.kind !== 'retail') throw new AppError('RANK_NOT_ALLOWED');
  return principal.accountId;
}

/**
 * The same function under its old name.
 *
 * Why: the top-up controller (`customer-topups.controller.ts`) still imports it under this name; the value is an account id.
 */
export const customerIdOf = accountIdOf;

/**
 * The answer of a staff wallet route that moved to the account routes.
 *
 * @param replacement the account route to use
 * @returns the error to throw
 */
function routeRetired(replacement: string): AppError {
  return new AppError('ROUTE_RETIRED', {
    detail: `Store balances belong to accounts now. Use ${replacement}.`,
  });
}

/**
 * The store balance routes of the store and the console.
 *
 * Why: the owner's store balance (ROADMAP 2W): a retail account reads its balance and a statement; staff list every live store wallet. The
 * staff read, adjust, freeze and unfreeze of one wallet are the wallet routes of `/admin/clients/:id` (every account, either wallet kind),
 * so the five old `/admin/customers/:id/wallet*` addresses stay registered during the expand release (decision 064) and answer
 * `410 ROUTE_RETIRED` naming the route to use; nothing is read or written. The access check of the route (session, permission, CSRF
 * token) and the validation of its old contract still come first. Every answer comes from the ledger account and is never cached; the
 * store answers carry `Cache-Control: no-store`.
 *
 * @route GET /store/v1/me/wallet
 * @route GET /store/v1/me/wallet/statement
 * @route GET /admin/customers/:id/wallet
 * @route GET /admin/customers/:id/wallet/statement
 * @route POST /admin/customers/:id/wallet/adjust
 * @route POST /admin/customers/:id/wallet/freeze
 * @route POST /admin/customers/:id/wallet/unfreeze
 * @route GET /admin/customer-wallets
 */
@Controller()
export class CustomerWalletController {
  constructor(private readonly wallets: CustomerWallets) {}

  /**
   * The signed-in account's store balance.
   *
   * @param principal the signed-in account (retail rank)
   * @returns the store wallet view
   * @throws {AppError} `RANK_NOT_ALLOWED` (403) for a merchant rank
   * @route GET /store/v1/me/wallet
   */
  @Route(getMyStoreWallet)
  @Header('Cache-Control', 'no-store')
  mine(@CurrentPrincipal() principal: Principal | undefined): Promise<ResultOf<typeof getMyStoreWallet>> {
    return this.wallets.viewForCustomer(accountIdOf(principal));
  }

  /**
   * The signed-in account's statement.
   *
   * @param principal the signed-in account (retail rank)
   * @param query the parsed list request
   * @returns the lines and their total
   * @throws {AppError} `RANK_NOT_ALLOWED` (403) for a merchant rank
   * @route GET /store/v1/me/wallet/statement
   */
  @Route(listMyStoreWalletStatement)
  @Header('Cache-Control', 'no-store')
  myStatement(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listMyStoreWalletStatement>,
  ): Promise<ResultOf<typeof listMyStoreWalletStatement>> {
    return this.wallets.statementForCustomer(accountIdOf(principal), query);
  }

  /**
   * Answers that the staff wallet read moved to the account wallet route.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route GET /admin/customers/:id/wallet
   */
  @Route(getCustomerWallet)
  show(): never {
    throw routeRetired('GET /admin/clients/:id/wallet');
  }

  /**
   * Answers that the staff statement moved to the account statement route.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route GET /admin/customers/:id/wallet/statement
   */
  @Route(listCustomerWalletStatement)
  statement(): never {
    throw routeRetired('GET /admin/clients/:id/statement');
  }

  /**
   * Answers that the manual adjustment moved to the account wallet route.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/wallet/adjust
   */
  @Route(adjustCustomerWallet)
  adjust(): never {
    throw routeRetired('POST /admin/clients/:id/wallet/adjust');
  }

  /**
   * Answers that the hold moved to the account wallet route.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/wallet/freeze
   */
  @Route(freezeCustomerWallet)
  freeze(): never {
    throw routeRetired('POST /admin/clients/:id/wallet/freeze');
  }

  /**
   * Answers that lifting the hold moved to the account wallet route.
   *
   * @throws {AppError} `ROUTE_RETIRED` (410)
   * @route POST /admin/customers/:id/wallet/unfreeze
   */
  @Route(unfreezeCustomerWallet)
  unfreeze(): never {
    throw routeRetired('POST /admin/clients/:id/wallet/unfreeze');
  }

  /**
   * Lists the live store wallets of accounts.
   *
   * @param query the parsed list request
   * @param staff the signed-in staff member (decides whether an account's address is shown and searched, decision 047)
   * @returns the page and the total
   * @route GET /admin/customer-wallets
   */
  @Route(listCustomerWallets)
  list(
    @Query() query: QueryOf<typeof listCustomerWallets>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof listCustomerWallets>> {
    return this.wallets.list(query, customerContactOf(staff));
  }
}
