// HTTP controller of the merchant portal's billing (map domain E, stage 8, MISMATCHES B162 and B163).
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
import { type AccountPrincipal, CurrentAccount } from '../../identity';
import { MerchantBillingService } from '../application/merchant-billing.service';
import {
  createMyInvoice,
  getMyInvoice,
  listMyInvoices,
  listMyPaymentMethods,
  uploadMyReceipt,
} from '../contracts/billing-portal.contracts';

/**
 * The merchant's own payment methods, invoices and receipts.
 *
 * Why: thin layer over {@link MerchantBillingService}; every route acts on the signed-in account only (its id comes from the session,
 * never from the request) and serves merchant ranks only (the rank gate of the `merchant-session` access, decision 064).
 *
 * @route GET /client/payment-methods
 * @route GET /client/invoices
 * @route GET /client/invoices/:id
 * @route POST /client/invoices
 * @route POST /client/invoices/:id/receipt
 */
@Controller()
export class ClientBillingController {
  constructor(private readonly billing: MerchantBillingService) {}

  /**
   * The payment methods open to the merchant.
   *
   * @param account the signed-in merchant account
   * @returns the methods
   * @route GET /client/payment-methods
   */
  @Route(listMyPaymentMethods)
  methods(@CurrentAccount() account: AccountPrincipal): Promise<ResultOf<typeof listMyPaymentMethods>> {
    return this.billing.methods(account.accountId);
  }

  /**
   * The merchant's invoices.
   *
   * @param account the signed-in merchant account
   * @param query sort, range, filters and search
   * @returns the page of invoices
   * @route GET /client/invoices
   */
  @Route(listMyInvoices)
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listMyInvoices>,
  ): Promise<ResultOf<typeof listMyInvoices>> {
    return this.billing.list(account.accountId, query);
  }

  /**
   * One invoice with its payments.
   *
   * @param account the signed-in merchant account
   * @param params the invoice id
   * @returns the invoice, its payments and how to pay
   * @route GET /client/invoices/:id
   */
  @Route(getMyInvoice)
  show(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof getMyInvoice>,
  ): Promise<ResultOf<typeof getMyInvoice>> {
    return this.billing.get(account.accountId, params.id);
  }

  /**
   * Asks for a top-up invoice.
   *
   * @param account the signed-in merchant account
   * @param body the amount and the payment method
   * @param headers the optional `Idempotency-Key`
   * @param reply the reply, for the replay marker
   * @returns the invoice with how to pay (`201`, also for a replay of the same key, marked `idempotency-replayed: true`)
   * @route POST /client/invoices
   */
  @Route(createMyInvoice)
  async create(
    @CurrentAccount() account: AccountPrincipal,
    @Body() body: BodyOf<typeof createMyInvoice>,
    @ContractHeaders() headers: HeadersOf<typeof createMyInvoice>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof createMyInvoice>> {
    const created = await this.billing.createInvoice(account.accountId, body, headers['idempotency-key']);
    if (created.replayed) reply.header('idempotency-replayed', 'true');
    return created.answer;
  }

  /**
   * Uploads the receipt of a bank transfer.
   *
   * @param account the signed-in merchant account
   * @param params the invoice id
   * @param body the receipt file, the bank reference and, for a staff-issued invoice, the payment method
   * @returns the new pending payment
   * @route POST /client/invoices/:id/receipt
   */
  @Route(uploadMyReceipt)
  receipt(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof uploadMyReceipt>,
    @Body() body: BodyOf<typeof uploadMyReceipt>,
  ): Promise<ResultOf<typeof uploadMyReceipt>> {
    return this.billing.uploadReceipt(account.accountId, params.id, body);
  }
}
