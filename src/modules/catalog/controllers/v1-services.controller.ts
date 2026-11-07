// HTTP controller of the catalog over REST v1 (map domain B, stage 7): the merchant's services at its own prices. Thin: the reads are
// MerchantApiCatalog.
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type Principal } from '../../identity';
import { MerchantApiCatalog } from '../application/merchant-api-catalog';
import { listV1Services, showV1Service } from '../contracts/v1-services.contracts';

/** The merchant behind an API key. */
function merchantIdOf(principal: Principal | undefined): number {
  if (principal?.kind !== 'api-key') throw new AppError('UNAUTHORIZED');
  return principal.clientId;
}

/**
 * The service routes of REST v1.
 *
 * Why: an integration lists what it may order at its own prices and reads the field schema of one service (scope `services:read`);
 * every price shown is remembered for the price guard of the order path (user rule 9).
 *
 * @route GET /v1/services
 * @route GET /v1/services/:id
 */
@Controller()
export class V1ServicesController {
  constructor(private readonly catalog: MerchantApiCatalog) {}

  /**
   * Lists a page of the catalog.
   *
   * @param principal the API-key principal
   * @param query the page size, cursor and filters
   * @returns the services and the next cursor
   * @route GET /v1/services
   */
  @Route(listV1Services)
  list(
    @CurrentPrincipal() principal: Principal | undefined,
    @Query() query: QueryOf<typeof listV1Services>,
  ): Promise<ResultOf<typeof listV1Services>> {
    return this.catalog.list(merchantIdOf(principal), query);
  }

  /**
   * Shows one service with its fields and options.
   *
   * @param principal the API-key principal
   * @param params the service id
   * @returns the service
   * @route GET /v1/services/:id
   */
  @Route(showV1Service)
  show(
    @CurrentPrincipal() principal: Principal | undefined,
    @Param() params: ParamsOf<typeof showV1Service>,
  ): Promise<ResultOf<typeof showV1Service>> {
    return this.catalog.show(merchantIdOf(principal), params.id);
  }
}
