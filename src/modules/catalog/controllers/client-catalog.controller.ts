// HTTP controller of the merchant catalog (map domain B, /client/services and /client/prices/export, stage 4). Thin: the
// rules live in ClientCatalogService.
import { Controller, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type Principal } from '../../identity';
import { ClientCatalogService } from '../application/client-catalog.service';
import { exportClientPrices, listClientServices, showClientService } from '../contracts/merchant-catalog.contracts';

/** The merchant behind a portal session. */
function merchantIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'merchant') throw new AppError('UNAUTHORIZED');
  return principal.clientId;
}

/**
 * The merchant catalog routes.
 *
 * Why: the merchant portal lists what the merchant may order at its own prices, draws the order form from one service's field
 * schema and exports the price list.
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
   * @param principal the signed-in merchant
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /client/services
   */
  @Route(listClientServices)
  list(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listClientServices>,
  ): Promise<ResultOf<typeof listClientServices>> {
    return this.catalog.list(merchantIdOf(principal), query);
  }

  /**
   * Shows one service with the field schema of its order form.
   *
   * @param principal the signed-in merchant
   * @param params the service id
   * @returns the service with its fields and options
   * @route GET /client/services/:id
   */
  @Route(showClientService)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof showClientService>,
  ): Promise<ResultOf<typeof showClientService>> {
    return this.catalog.show(merchantIdOf(principal), params.id);
  }

  /**
   * Exports the merchant's price list as a CSV file.
   *
   * @param principal the signed-in merchant
   * @param query the optional `type` and `categoryId` filters
   * @param reply the reply, for the file headers
   * @returns the CSV text
   * @route GET /client/prices/export
   */
  @Route(exportClientPrices)
  async export(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof exportClientPrices>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const csv = await this.catalog.exportCsv(merchantIdOf(principal), {
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
