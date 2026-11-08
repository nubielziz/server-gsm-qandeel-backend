// HTTP controller of the staff IMEI log (map domain K, stage 18). Thin: the rules live in ImeiCheckAdminService.
import { Controller, Header, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { ImeiCheckAdminService } from '../application/imei-check-admin.service';
import { getImeiCheck, listImeiChecks } from '../contracts/admin-imei-checks.contracts';

/**
 * The console's IMEI checks tab.
 *
 * Why: staff read the log of checks and their results (RESOLUTIONS b2c-3, b2c-4); the IMEI is decrypted for the answer, which is
 * never cached.
 *
 * @route GET /admin/imei-checks
 * @route GET /admin/imei-checks/:id
 */
@Controller()
export class ImeiChecksAdminController {
  constructor(private readonly checks: ImeiCheckAdminService) {}

  /**
   * Lists the checks.
   *
   * @param query the parsed list request
   * @returns the page and its total
   * @route GET /admin/imei-checks
   */
  @Route(listImeiChecks)
  @Header('Cache-Control', 'no-store')
  list(@Query() query: QueryOf<typeof listImeiChecks>): Promise<ResultOf<typeof listImeiChecks>> {
    return this.checks.list(query);
  }

  /**
   * Reads one check.
   *
   * @param params the check id
   * @returns the check
   * @route GET /admin/imei-checks/:id
   */
  @Route(getImeiCheck)
  @Header('Cache-Control', 'no-store')
  show(@Param() params: ParamsOf<typeof getImeiCheck>): Promise<ResultOf<typeof getImeiCheck>> {
    return this.checks.get(params.id);
  }
}
