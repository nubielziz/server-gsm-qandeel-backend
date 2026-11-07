// HTTP controller of the merchant portal's billing (map domain E, stage 8, MISMATCHES B162 and B163).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentMerchant, type MerchantPrincipal } from '../../identity';
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
 * Why: thin layer over {@link MerchantBillingService}; every route acts on the signed-in merchant only.
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
   * @param merchant the signed-in merchant
   * @returns the methods
   * @route GET /client/payment-methods
   */
  @Route(listMyPaymentMethods)
  methods(@CurrentMerchant() merchant: MerchantPrincipal): Promise<ResultOf<typeof listMyPaymentMethods>> {
    return this.billing.methods(merchant.clientId);
  }

  /**
   * The merchant's invoices.
   *
   * @param merchant the signed-in merchant
   * @param query sort, range, filters and search
   * @returns the page of invoices
   * @route GET /client/invoices
   */
  @Route(listMyInvoices)
  list(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Query() query: QueryOf<typeof listMyInvoices>,
  ): Promise<ResultOf<typeof listMyInvoices>> {
    return this.billing.list(merchant.clientId, query);
  }

  /**
   * One invoice with its payments.
   *
   * @param merchant the signed-in merchant
   * @param params the invoice id
   * @returns the invoice, its payments and how to pay
   * @route GET /client/invoices/:id
   */
  @Route(getMyInvoice)
  show(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof getMyInvoice>,
  ): Promise<ResultOf<typeof getMyInvoice>> {
    return this.billing.get(merchant.clientId, params.id);
  }

  /**
   * Asks for a top-up invoice.
   *
   * @param merchant the signed-in merchant
   * @param body the amount and the payment method
   * @returns the invoice with how to pay
   * @route POST /client/invoices
   */
  @Route(createMyInvoice)
  create(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Body() body: BodyOf<typeof createMyInvoice>,
  ): Promise<ResultOf<typeof createMyInvoice>> {
    return this.billing.createInvoice(merchant.clientId, body);
  }

  /**
   * Uploads the receipt of a bank transfer.
   *
   * @param merchant the signed-in merchant
   * @param params the invoice id
   * @param body the receipt file, the bank reference and, for a staff-issued invoice, the payment method
   * @returns the new pending payment
   * @route POST /client/invoices/:id/receipt
   */
  @Route(uploadMyReceipt)
  receipt(
    @CurrentMerchant() merchant: MerchantPrincipal,
    @Param() params: ParamsOf<typeof uploadMyReceipt>,
    @Body() body: BodyOf<typeof uploadMyReceipt>,
  ): Promise<ResultOf<typeof uploadMyReceipt>> {
    return this.billing.uploadReceipt(merchant.clientId, params.id, body);
  }
}
