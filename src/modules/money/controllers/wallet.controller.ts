// HTTP controller of the wallets of accounts (map domain E, stage 3; decision 064): the admin console's /admin/clients/:id/wallet routes for
// both wallet kinds and the merchant portal's /client/wallet routes. Thin: it maps inputs to the use cases.
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
import { type AccountPrincipal, CurrentAccount, CurrentStaff, type StaffPrincipal } from '../../identity';
import { AccountWalletAdmin } from '../application/account-wallet-admin';
import { STATEMENT_EXPORT_LIMIT, WalletService } from '../application/wallet.service';
import {
  adjustClientWallet,
  freezeClientWallet,
  getClientWallet,
  getMyWallet,
  listClientStatement,
  listMyStatement,
  setClientCreditLimit,
  unfreezeClientWallet,
} from '../contracts/wallet.contracts';
import { statementCsv } from '../domain/statement-csv';

/**
 * The wallet routes of the console and the portal.
 *
 * Why: staff read the wallet and the statement of an account of either rank, adjust the live wallet with a reason, set a merchant credit limit
 * and hold or release the wallet, all with an `Idempotency-Key`; the merchant reads its own wallet and statement (map stage 3, decision 064).
 * Every answer comes straight from the ledger accounts and is never cached.
 *
 * @route GET /admin/clients/:id/wallet
 * @route GET /admin/clients/:id/statement
 * @route POST /admin/clients/:id/wallet/adjust
 * @route PATCH /admin/clients/:id/credit-limit
 * @route POST /admin/clients/:id/wallet/freeze
 * @route POST /admin/clients/:id/wallet/unfreeze
 * @route GET /client/wallet
 * @route GET /client/wallet/statement
 */
@Controller()
export class WalletController {
  constructor(
    private readonly admin: AccountWalletAdmin,
    private readonly wallets: WalletService,
  ) {}

  /**
   * The live wallet of an account.
   *
   * @param params the account id
   * @returns the wallet of the kind the rank gives now
   * @route GET /admin/clients/:id/wallet
   */
  @Route(getClientWallet)
  show(@Param() params: ParamsOf<typeof getClientWallet>): Promise<ResultOf<typeof getClientWallet>> {
    return this.admin.show(params.id);
  }

  /**
   * A page of the statement of a wallet of the account.
   *
   * @param params the account id
   * @param query the parsed list request (window and `wallet`)
   * @returns the lines and their total
   * @route GET /admin/clients/:id/statement
   */
  @Route(listClientStatement)
  statement(
    @Param() params: ParamsOf<typeof listClientStatement>,
    @Query() query: QueryOf<typeof listClientStatement>,
  ): Promise<ResultOf<typeof listClientStatement>> {
    return this.admin.statement(params.id, query);
  }

  /**
   * Adds to or deducts from the live wallet.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @param body amount, direction and reason
   * @param headers the required idempotency key
   * @param reply the reply, for the replay marker
   * @returns the journal id and the wallet after posting
   * @route POST /admin/clients/:id/wallet/adjust
   */
  @Route(adjustClientWallet)
  async adjust(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof adjustClientWallet>,
    @Body() body: BodyOf<typeof adjustClientWallet>,
    @ContractHeaders() headers: HeadersOf<typeof adjustClientWallet>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof adjustClientWallet>> {
    const done = await this.admin.adjust(staff, params.id, { ...body, idempotencyKey: headers['idempotency-key'] });
    if (done.replayed) void reply.header('idempotency-replayed', 'true');
    return { transactionId: done.transactionId, wallet: done.wallet };
  }

  /**
   * Sets the credit limit of a merchant wallet.
   *
   * @param staff the signed-in staff member (a raise above the approval limit needs an Owner, decision 049)
   * @param params the account id
   * @param body the new limit
   * @param headers the required idempotency key
   * @param reply the reply, for the replay marker
   * @returns the wallet after the change
   * @route PATCH /admin/clients/:id/credit-limit
   */
  @Route(setClientCreditLimit)
  async setCreditLimit(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof setClientCreditLimit>,
    @Body() body: BodyOf<typeof setClientCreditLimit>,
    @ContractHeaders() headers: HeadersOf<typeof setClientCreditLimit>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof setClientCreditLimit>> {
    const done = await this.admin.setCreditLimit(staff, params.id, body.creditLimit, headers['idempotency-key']);
    if (done.replayed) void reply.header('idempotency-replayed', 'true');
    return done.wallet;
  }

  /**
   * Puts the live wallet on hold.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @param body the reason
   * @param headers the required idempotency key
   * @param reply the reply, for the replay marker
   * @returns the wallet after the change
   * @route POST /admin/clients/:id/wallet/freeze
   */
  @Route(freezeClientWallet)
  async freeze(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof freezeClientWallet>,
    @Body() body: BodyOf<typeof freezeClientWallet>,
    @ContractHeaders() headers: HeadersOf<typeof freezeClientWallet>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof freezeClientWallet>> {
    const done = await this.admin.freeze(staff, params.id, body.reason, headers['idempotency-key']);
    if (done.replayed) void reply.header('idempotency-replayed', 'true');
    return done.wallet;
  }

  /**
   * Lifts the hold on the live wallet.
   *
   * @param staff the signed-in staff member
   * @param params the account id
   * @param body the reason
   * @param headers the required idempotency key
   * @param reply the reply, for the replay marker
   * @returns the wallet after the change
   * @route POST /admin/clients/:id/wallet/unfreeze
   */
  @Route(unfreezeClientWallet)
  async unfreeze(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof unfreezeClientWallet>,
    @Body() body: BodyOf<typeof unfreezeClientWallet>,
    @ContractHeaders() headers: HeadersOf<typeof unfreezeClientWallet>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof unfreezeClientWallet>> {
    const done = await this.admin.unfreeze(staff, params.id, body.reason, headers['idempotency-key']);
    if (done.replayed) void reply.header('idempotency-replayed', 'true');
    return done.wallet;
  }

  /**
   * The signed-in merchant's wallet.
   *
   * @param account the signed-in account (merchant rank: the rank gate has refused any other)
   * @returns balance, reserved, credit limit and available
   * @route GET /client/wallet
   */
  @Route(getMyWallet)
  mine(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof getMyWallet>> {
    return this.wallets.viewForMerchant(account.accountId);
  }

  /**
   * The signed-in merchant's statement, as a page or a CSV file.
   *
   * With `?format=csv` the reply is every line (up to 10,000) as `text/csv`: the handler asks Fastify to serialise this one
   * reply as CSV, so the contract still checks the rows and sets `x-total-count`.
   *
   * @param account the signed-in account (merchant rank)
   * @param query the parsed list request and the format
   * @param reply the reply, to switch the serialiser for the CSV file
   * @returns the lines and their total
   * @route GET /client/wallet/statement
   */
  @Route(listMyStatement)
  myStatement(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listMyStatement>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof listMyStatement>> {
    const order = query.sort[0]?.order ?? 'desc';
    if (query.extra.format !== 'csv') return this.wallets.statementOf(account.accountId, order, query.range);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="statement.csv"')
      .header('cache-control', 'no-store')
      .serializer((rows: unknown) => statementCsv(rows as Parameters<typeof statementCsv>[0]));
    return this.wallets.statementOf(account.accountId, order, { start: 0, limit: STATEMENT_EXPORT_LIMIT });
  }
}
