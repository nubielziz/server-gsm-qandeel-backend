// HTTP controller of the invoices for staff (map domain E, stage 8, routes /admin/invoices).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal, customerContactOf } from '../../identity';
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
   * @param staff the signed-in staff member (decides whether a customer's address is shown in full, decision 047)
   * @returns the page of invoices
   * @route GET /admin/invoices
   */
  @Route(listInvoices)
  list(
    @Query() query: QueryOf<typeof listInvoices>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof listInvoices>> {
    return this.invoices.list(query, customerContactOf(staff));
  }

  /**
   * Reads one invoice.
   *
   * @param params the invoice id
   * @param staff the signed-in staff member (decides whether a customer's address is shown in full, decision 047)
   * @returns the invoice
   * @route GET /admin/invoices/:id
   */
  @Route(getInvoice)
  show(
    @Param() params: ParamsOf<typeof getInvoice>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof getInvoice>> {
    return this.invoices.get(params.id, customerContactOf(staff));
  }

  /**
   * Issues a manual invoice.
   *
   * @param staff the signed-in staff member: the invoice records them as its issuer (decision 049), and they decide whether a
   *   customer's address is shown in full in the answer (decision 047)
   * @param body the merchant, the amount and the description
   * @returns the new invoice
   * @route POST /admin/invoices
   */
  @Route(createInvoice)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createInvoice>,
  ): Promise<ResultOf<typeof createInvoice>> {
    return this.invoices.issue(staff, body);
  }
}
