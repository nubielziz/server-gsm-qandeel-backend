// HTTP controller of the invoices for staff (map domain E, stage 8, routes /admin/invoices).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { InvoiceAdminService } from '../application/invoice-admin.service';
import { createInvoice, getInvoice, listInvoices } from '../contracts/invoices.contracts';

/**
 * Routes of the invoices.
 *
 * Why: thin layer over {@link InvoiceAdminService}.
 *
 * @route GET /admin/invoices
 * @route GET /admin/invoices/:id
 * @route POST /admin/invoices
 */
@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoiceAdminService) {}

  /**
   * Lists the invoices.
   *
   * @param query sort, range, filters and search
   * @returns the page of invoices
   * @route GET /admin/invoices
   */
  @Route(listInvoices)
  list(@Query() query: QueryOf<typeof listInvoices>): Promise<ResultOf<typeof listInvoices>> {
    return this.invoices.list(query);
  }

  /**
   * Reads one invoice.
   *
   * @param params the invoice id
   * @returns the invoice
   * @route GET /admin/invoices/:id
   */
  @Route(getInvoice)
  show(@Param() params: ParamsOf<typeof getInvoice>): Promise<ResultOf<typeof getInvoice>> {
    return this.invoices.get(params.id);
  }

  /**
   * Issues a manual invoice.
   *
   * @param body the merchant, the amount and the description
   * @returns the new invoice
   * @route POST /admin/invoices
   */
  @Route(createInvoice)
  create(@Body() body: BodyOf<typeof createInvoice>): Promise<ResultOf<typeof createInvoice>> {
    return this.invoices.issue(body);
  }
}
