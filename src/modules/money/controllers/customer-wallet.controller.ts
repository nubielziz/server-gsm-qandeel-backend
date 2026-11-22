// HTTP controller of the customer store balance (feature 21, plan § 7.1 routes 1, 2 and 11 to 16): the customer's own wallet and statement
// on the store, and the staff wallet routes under /admin/customers/:id/wallet and /admin/customer-wallets. Thin: it maps inputs to the use case.
import { Body, Controller, Header, Param, Query } from '@nestjs/common';
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
 * The customer behind a store session.
 *
 * Why: plan 21 § 5.1 invariant 5: every customer id comes from the authenticated principal (money cannot import the customers module's
 * `@CurrentCustomer`, decision 032).
 *
 * @param principal the request's principal
 * @returns the customer id
 * @throws {AppError} `UNAUTHORIZED` when the request was not authenticated as a customer
 */
export function customerIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'customer') throw new AppError('UNAUTHORIZED');
  return principal.customerId;
}

/**
 * The customer wallet routes of the store and the console.
 *
 * Why: the owner's customer wallet (ROADMAP 2W): the customer reads the balance and a statement; staff read, adjust, freeze, unfreeze and
 * list. Every answer comes from the ledger account and is never cached; the store answers carry `Cache-Control: no-store`.
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
   * The signed-in customer's store balance.
   *
   * @param principal the signed-in customer
   * @returns the store wallet view
   * @route GET /store/v1/me/wallet
   */
  @Route(getMyStoreWallet)
  @Header('Cache-Control', 'no-store')
  mine(@CurrentPrincipal() principal: Principal | undefined): Promise<ResultOf<typeof getMyStoreWallet>> {
    return this.wallets.viewForCustomer(customerIdOf(principal));
  }

  /**
   * The signed-in customer's statement.
   *
   * @param principal the signed-in customer
   * @param query the parsed list request
   * @returns the lines and their total
   * @route GET /store/v1/me/wallet/statement
   */
  @Route(listMyStoreWalletStatement)
  @Header('Cache-Control', 'no-store')
  myStatement(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listMyStoreWalletStatement>,
  ): Promise<ResultOf<typeof listMyStoreWalletStatement>> {
    return this.wallets.statementForCustomer(customerIdOf(principal), query);
  }

  /**
   * A customer's wallet, for staff.
   *
   * @param params the customer id
   * @returns the staff wallet view
   * @route GET /admin/customers/:id/wallet
   */
  @Route(getCustomerWallet)
  show(@Param() params: ParamsOf<typeof getCustomerWallet>): Promise<ResultOf<typeof getCustomerWallet>> {
    return this.wallets.viewForStaff(params.id);
  }

  /**
   * A customer's statement, for staff.
   *
   * @param params the customer id
   * @param query the parsed list request
   * @returns the lines and their total
   * @route GET /admin/customers/:id/wallet/statement
   */
  @Route(listCustomerWalletStatement)
  statement(
    @Param() params: ParamsOf<typeof listCustomerWalletStatement>,
    @Query() query: QueryOf<typeof listCustomerWalletStatement>,
  ): Promise<ResultOf<typeof listCustomerWalletStatement>> {
    return this.wallets.statementForStaff(params.id, query);
  }

  /**
   * Adds to or deducts from a customer's balance.
   *
   * @param staff the signed-in staff member
   * @param params the customer id
   * @param body amount, direction and reason
   * @param headers the required idempotency key
   * @returns the journal id and the wallet after posting
   * @route POST /admin/customers/:id/wallet/adjust
   */
  @Route(adjustCustomerWallet)
  adjust(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof adjustCustomerWallet>,
    @Body() body: BodyOf<typeof adjustCustomerWallet>,
    @ContractHeaders() headers: HeadersOf<typeof adjustCustomerWallet>,
  ): Promise<ResultOf<typeof adjustCustomerWallet>> {
    return this.wallets.adjust(staff, params.id, { ...body, idempotencyKey: headers['idempotency-key'] });
  }

  /**
   * Puts a customer's balance on hold.
   *
   * @param params the customer id
   * @param body the reason
   * @param _headers the required idempotency key (validated; the use case is idempotent by state)
   * @returns the wallet after the change
   * @route POST /admin/customers/:id/wallet/freeze
   */
  @Route(freezeCustomerWallet)
  freeze(
    @Param() params: ParamsOf<typeof freezeCustomerWallet>,
    @Body() body: BodyOf<typeof freezeCustomerWallet>,
    @ContractHeaders() _headers: HeadersOf<typeof freezeCustomerWallet>,
  ): Promise<ResultOf<typeof freezeCustomerWallet>> {
    return this.wallets.freeze(params.id, body.reason);
  }

  /**
   * Lifts the hold on a customer's balance.
   *
   * @param params the customer id
   * @param body the reason
   * @param _headers the required idempotency key (validated; the use case is idempotent by state)
   * @returns the wallet after the change
   * @route POST /admin/customers/:id/wallet/unfreeze
   */
  @Route(unfreezeCustomerWallet)
  unfreeze(
    @Param() params: ParamsOf<typeof unfreezeCustomerWallet>,
    @Body() body: BodyOf<typeof unfreezeCustomerWallet>,
    @ContractHeaders() _headers: HeadersOf<typeof unfreezeCustomerWallet>,
  ): Promise<ResultOf<typeof unfreezeCustomerWallet>> {
    return this.wallets.unfreeze(params.id, body.reason);
  }

  /**
   * Lists customer wallets.
   *
   * @param query the parsed list request
   * @param staff the signed-in staff member (decides whether a customer's address is shown and searched, decision 047)
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
