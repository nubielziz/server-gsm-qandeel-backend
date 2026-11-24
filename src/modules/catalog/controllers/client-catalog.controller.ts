// HTTP controller of the merchant catalog (map domain B, /client/services and /client/prices/export, stage 4). Thin: the
// rules live in ClientCatalogService.
import { Controller, Header, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { type AccountPrincipal, CurrentAccount } from '../../identity';
import { ClientCatalogService } from '../application/client-catalog.service';
import { exportClientPrices, listClientServices, showClientService } from '../contracts/merchant-catalog.contracts';

/**
 * The merchant catalog routes.
 *
 * Why: the merchant portal lists what the merchant may order at its own prices, draws the order form from one service's field
 * schema and exports the price list. The routes are for accounts of a merchant rank: the rank gate answers 403 `RANK_NOT_ALLOWED` to
 * any other (decision 064), and the service checks the rank once more. The list and the show answer `Cache-Control: private, no-store`:
 * they carry the merchant's own prices, and the shop reads them in the browser through its own host (decision 066), so no shared cache
 * and no browser cache may keep them.
 *
 * @route GET /client/services
 * @route GET /client/services/:id
 * @route GET /client/prices/export
 */
@Controller()
export class ClientCatalogController {
  constructor(private readonly catalog: ClientCatalogService) {}

  /**
   * Lists the merchant's catalog.
   *
   * @param account the signed-in account (a merchant rank)
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /client/services
   */
  @Route(listClientServices)
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof listClientServices>,
  ): Promise<ResultOf<typeof listClientServices>> {
    return this.catalog.list(account.accountId, query);
  }

  /**
   * Shows one service with the field schema of its order form.
   *
   * @param account the signed-in account (a merchant rank)
   * @param params the service id
   * @returns the service with its fields and options
   * @route GET /client/services/:id
   */
  @Route(showClientService)
  @Header('Cache-Control', 'private, no-store')
  show(
    @CurrentAccount() account: AccountPrincipal,
    @Param() params: ParamsOf<typeof showClientService>,
  ): Promise<ResultOf<typeof showClientService>> {
    return this.catalog.show(account.accountId, params.id);
  }

  /**
   * Exports the merchant's price list as a CSV file.
   *
   * @param account the signed-in account (a merchant rank)
   * @param query the optional `type` and `categoryId` filters
   * @param reply the reply, for the file headers
   * @returns the CSV text
   * @route GET /client/prices/export
   */
  @Route(exportClientPrices)
  async export(
    @CurrentAccount() account: AccountPrincipal,
    @Query() query: QueryOf<typeof exportClientPrices>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const csv = await this.catalog.exportCsv(account.accountId, {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
    });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="price-list.csv"')
      .header('cache-control', 'no-store');
    return csv;
  }
}
