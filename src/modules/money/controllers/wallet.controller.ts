// HTTP controller of merchant wallets (map domain E, stage 3): the admin console's /admin/clients/:id/wallet routes and the
// merchant portal's /client/wallet routes. Thin: it maps inputs to the wallet service.
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
import { CurrentPrincipal, CurrentStaff, type Principal, type StaffPrincipal } from '../../identity';
import {
  adjustClientWallet,
  getClientWallet,
  getMyWallet,
  listClientStatement,
  listMyStatement,
  setClientCreditLimit,
} from '../contracts/wallet.contracts';
import { statementCsv } from '../domain/statement-csv';
import { STATEMENT_EXPORT_LIMIT, WalletService } from '../application/wallet.service';

/** The merchant behind a portal session. */
function merchantIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'merchant') throw new AppError('UNAUTHORIZED');
  return principal.clientId;
}

/**
 * The wallet routes of the console and the portal.
 *
 * Why: staff read a merchant's wallet and statement, adjust it with a reason and set its credit limit; the merchant reads
 * its own wallet and statement (map stage 3). Every answer comes straight from the ledger accounts and is never cached.
 *
 * @route GET /admin/clients/:id/wallet
 * @route GET /admin/clients/:id/statement
 * @route POST /admin/clients/:id/wallet/adjust
 * @route PATCH /admin/clients/:id/credit-limit
 * @route GET /client/wallet
 * @route GET /client/wallet/statement
 */
@Controller()
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  /**
   * A merchant's wallet figures.
   *
   * @param params the merchant id
   * @returns balance, reserved, credit limit and available
   * @route GET /admin/clients/:id/wallet
   */
  @Route(getClientWallet)
  show(@Param() params: ParamsOf<typeof getClientWallet>): Promise<ResultOf<typeof getClientWallet>> {
    return this.wallets.viewForStaff(params.id);
  }

  /**
   * A page of a merchant's statement.
   *
   * @param params the merchant id
   * @param query the parsed list request
   * @returns the lines and their total
   * @route GET /admin/clients/:id/statement
   */
  @Route(listClientStatement)
  statement(
    @Param() params: ParamsOf<typeof listClientStatement>,
    @Query() query: QueryOf<typeof listClientStatement>,
  ): Promise<ResultOf<typeof listClientStatement>> {
    return this.wallets.statementForStaff(params.id, query);
  }

  /**
   * Adds to or deducts from a wallet.
   *
   * @param staff the signed-in staff member
   * @param params the merchant id
   * @param body amount, direction and reason
   * @param headers the optional idempotency key
   * @returns the journal id and the wallet after posting
   * @route POST /admin/clients/:id/wallet/adjust
   */
  @Route(adjustClientWallet)
  adjust(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof adjustClientWallet>,
    @Body() body: BodyOf<typeof adjustClientWallet>,
    @ContractHeaders() headers: HeadersOf<typeof adjustClientWallet>,
  ): Promise<ResultOf<typeof adjustClientWallet>> {
    const idempotencyKey = headers['idempotency-key'];
    return this.wallets.adjust(staff.staffId, params.id, { ...body, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  /**
   * Sets a merchant's credit limit.
   *
   * @param params the merchant id
   * @param body the new limit
   * @returns the wallet after the change
   * @route PATCH /admin/clients/:id/credit-limit
   */
  @Route(setClientCreditLimit)
  setCreditLimit(
    @Param() params: ParamsOf<typeof setClientCreditLimit>,
    @Body() body: BodyOf<typeof setClientCreditLimit>,
  ): Promise<ResultOf<typeof setClientCreditLimit>> {
    return this.wallets.setCreditLimit(params.id, body.creditLimit);
  }

  /**
   * The signed-in merchant's wallet.
   *
   * @param principal the signed-in merchant
   * @returns balance, reserved, credit limit and available
   * @route GET /client/wallet
   */
  @Route(getMyWallet)
  mine(@CurrentPrincipal() principal: Principal | undefined): Promise<ResultOf<typeof getMyWallet>> {
    return this.wallets.viewForMerchant(merchantIdOf(principal));
  }

  /**
   * The signed-in merchant's statement, as a page or a CSV file.
   *
   * With `?format=csv` the reply is every line (up to 10,000) as `text/csv`: the handler asks Fastify to serialise this one
   * reply as CSV, so the contract still checks the rows and sets `x-total-count`.
   *
   * @param principal the signed-in merchant
   * @param query the parsed list request and the format
   * @param reply the reply, to switch the serialiser for the CSV file
   * @returns the lines and their total
   * @route GET /client/wallet/statement
   */
  @Route(listMyStatement)
  myStatement(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listMyStatement>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof listMyStatement>> {
    const clientId = merchantIdOf(principal);
    const order = query.sort[0]?.order ?? 'desc';
    if (query.extra.format !== 'csv') return this.wallets.statementOf(clientId, order, query.range);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="statement.csv"')
      .header('cache-control', 'no-store')
      .serializer((rows: unknown) => statementCsv(rows as Parameters<typeof statementCsv>[0]));
    return this.wallets.statementOf(clientId, order, { start: 0, limit: STATEMENT_EXPORT_LIMIT });
  }
}
