// HTTP controller of the storefront money reports (map domain E, stage 16, routes GET /admin/reports/vat and /payments).
import { Controller, Query } from '@nestjs/common';
import { type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { B2cReportsService } from '../application/b2c-reports.service';
import { getPaymentsReport, getVatReport } from '../contracts/b2c-reports.contracts';

/**
 * Routes of the VAT and payments reports.
 *
 * Why: thin layer over {@link B2cReportsService}.
 *
 * @route GET /admin/reports/vat
 * @route GET /admin/reports/payments
 */
@Controller()
export class B2cReportsController {
  constructor(private readonly reports: B2cReportsService) {}

  /**
   * The VAT report.
   *
   * @param query the two days
   * @returns VAT by country and month
   * @route GET /admin/reports/vat
   */
  @Route(getVatReport)
  vat(@Query() query: QueryOf<typeof getVatReport>): Promise<ResultOf<typeof getVatReport>> {
    return this.reports.vat(query);
  }

  /**
   * The payments report.
   *
   * @param query the method filter, range and sort
   * @returns the report
   * @route GET /admin/reports/payments
   */
  @Route(getPaymentsReport)
  payments(@Query() query: QueryOf<typeof getPaymentsReport>): Promise<ResultOf<typeof getPaymentsReport>> {
    return this.reports.payments(query);
  }
}
