// HTTP controller of the supplier chain of a service (its read: decision 060) and of the supplier call log (stage 6). Thin.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { SupplierCatalogueService } from '../application/supplier-catalogue.service';
import { SupplierLogService } from '../application/supplier-log.service';
import {
  listSupplierApiLogs,
  replaceSupplierLinks,
  showServiceSupplierLinks,
  showSupplierApiLog,
} from '../contracts/supplier-links-logs.contracts';

/**
 * The supplier chain and call log routes.
 *
 * Why: the service editor routes a service to suppliers in priority order (and reads the chain it edits, decision 060); support
 * reads every call made to a supplier.
 *
 * @route GET /admin/services/:id/supplier-links
 * @route PUT /admin/services/:id/supplier-links
 * @route GET /admin/supplier-api-logs
 * @route GET /admin/supplier-api-logs/:id
 */
@Controller()
export class SupplierLinksLogsController {
  constructor(
    private readonly catalogue: SupplierCatalogueService,
    private readonly logs: SupplierLogService,
  ) {}

  /**
   * Shows the supplier chain of a service.
   *
   * @param params the service id
   * @returns the chain in priority order; `[]` when the service has no link
   * @route GET /admin/services/:id/supplier-links
   */
  @Route(showServiceSupplierLinks)
  showLinks(
    @Param() params: ParamsOf<typeof showServiceSupplierLinks>,
  ): Promise<ResultOf<typeof showServiceSupplierLinks>> {
    return this.catalogue.chainOf(params.id);
  }

  /**
   * Replaces the supplier chain of a service.
   *
   * @param params the service id
   * @param body the new chain
   * @returns the chain as saved
   * @route PUT /admin/services/:id/supplier-links
   */
  @Route(replaceSupplierLinks)
  replaceLinks(
    @Param() params: ParamsOf<typeof replaceSupplierLinks>,
    @Body() body: BodyOf<typeof replaceSupplierLinks>,
  ): Promise<ResultOf<typeof replaceSupplierLinks>> {
    return this.catalogue.replaceLinks(params.id, body.links);
  }

  /**
   * Lists supplier calls.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/supplier-api-logs
   */
  @Route(listSupplierApiLogs)
  list(@Query() query: QueryOf<typeof listSupplierApiLogs>): Promise<ResultOf<typeof listSupplierApiLogs>> {
    return this.logs.list(query);
  }

  /**
   * Shows a supplier call with its bodies.
   *
   * @param params the log row id
   * @returns the call
   * @route GET /admin/supplier-api-logs/:id
   */
  @Route(showSupplierApiLog)
  show(@Param() params: ParamsOf<typeof showSupplierApiLog>): Promise<ResultOf<typeof showSupplierApiLog>> {
    return this.logs.show(params.id);
  }
}
