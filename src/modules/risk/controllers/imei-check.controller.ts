// HTTP controller of the storefront IMEI check (map domain K, stage 14). Thin: the rules live in ImeiCheckService.
import { Body, Controller, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { ImeiCheckService } from '../application/imei-check.service';
import { checkStoreImei } from '../contracts/imei-check.contracts';
import { countryFromHeader } from '../domain/imei-check';

/**
 * The storefront IMEI check route.
 *
 * Why: the shop checks an IMEI before payment (map stage 14); the Turnstile guard and the per-IP limit run before this.
 *
 * @route POST /store/v1/imei/check
 */
@Controller()
export class ImeiCheckController {
  constructor(
    private readonly checks: ImeiCheckService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Checks an IMEI.
   *
   * @param body the IMEI and the optional service
   * @param request the request, for the visitor's address and the proxy's country header
   * @returns the outcome
   * @route POST /store/v1/imei/check
   */
  @Route(checkStoreImei)
  check(
    @Body() body: BodyOf<typeof checkStoreImei>,
    @Req() request: FastifyRequest,
  ): Promise<ResultOf<typeof checkStoreImei>> {
    const header = this.config.http.geoipCountryHeader;
    return this.checks.check({
      imei: body.imei,
      serviceId: body.serviceId,
      ip: request.ip,
      country: header === undefined ? null : countryFromHeader(request.headers[header]),
    });
  }
}
