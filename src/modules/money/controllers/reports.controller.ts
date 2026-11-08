// HTTP controller of the money reports (map domain E, /admin/reports/*, stage 11). Thin: the figures live in ReportService.
import { Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { attachmentDisposition } from '../../../infra/storage';
import { ClientStatementService } from '../application/client-statement.service';
import { ReportService } from '../application/report.service';
import {
  getClientStatement,
  getProfitReport,
  getSupplierReport,
  getTopClients,
  getWalletExposure,
} from '../contracts/reports.contracts';

/** What the supplier report uses when the console sends no `days`. */
const DEFAULT_SUPPLIER_DAYS = 7;
/** What the top merchants report uses when the console sends no `days` or `limit`. */
const DEFAULT_TOP_DAYS = 7;
const DEFAULT_TOP_LIMIT = 6;

/**
 * The report routes.
 *
 * Why: the console's Finance Reports tab (profit, wallet exposure), the Suppliers page (supplier report), the dashboard (top
 * merchants, wallet exposure) and the merchant page (the official statement PDF).
 *
 * @route GET /admin/reports/profit
 * @route GET /admin/reports/wallet-exposure
 * @route GET /admin/reports/suppliers
 * @route GET /admin/reports/top-clients
 * @route GET /admin/reports/client-statement/:clientId
 */
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportService,
    private readonly statements: ClientStatementService,
  ) {}

  /**
   * Profit by day, service, supplier or merchant.
   *
   * @param query the split and the range of days
   * @returns the rows and the totals
   * @route GET /admin/reports/profit
   */
  @Route(getProfitReport)
  profit(@Query() query: QueryOf<typeof getProfitReport>): Promise<ResultOf<typeof getProfitReport>> {
    return this.reports.profit(query);
  }

  /**
   * Wallet balances, credit in use and reserved amounts.
   *
   * @returns the totals and the largest wallets
   * @route GET /admin/reports/wallet-exposure
   */
  @Route(getWalletExposure)
  exposure(): Promise<ResultOf<typeof getWalletExposure>> {
    return this.reports.walletExposure();
  }

  /**
   * Supplier spend, rejection rate and speed.
   *
   * @param query the window in days
   * @returns one row per supplier
   * @route GET /admin/reports/suppliers
   */
  @Route(getSupplierReport)
  suppliers(@Query() query: QueryOf<typeof getSupplierReport>): Promise<ResultOf<typeof getSupplierReport>> {
    return this.reports.suppliers(query.days ?? DEFAULT_SUPPLIER_DAYS);
  }

  /**
   * Top merchants by spend and profit.
   *
   * @param query the window in days and how many merchants
   * @returns the ranked merchants
   * @route GET /admin/reports/top-clients
   */
  @Route(getTopClients)
  topClients(@Query() query: QueryOf<typeof getTopClients>): Promise<ResultOf<typeof getTopClients>> {
    return this.reports.topClients(query.days ?? DEFAULT_TOP_DAYS, query.limit ?? DEFAULT_TOP_LIMIT);
  }

  /**
   * The official account statement of a merchant, as a PDF download.
   *
   * @param params the merchant id
   * @param query the optional first and last day
   * @param reply the reply, for the file headers
   * @returns the PDF bytes
   * @route GET /admin/reports/client-statement/:clientId
   */
  @Route(getClientStatement)
  async clientStatement(
    @Param() params: ParamsOf<typeof getClientStatement>,
    @Query() query: QueryOf<typeof getClientStatement>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const file = await this.statements.render(params.clientId, query);
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', attachmentDisposition(file.filename))
      .header('cache-control', 'no-store');
    return Buffer.from(file.bytes);
  }
}
