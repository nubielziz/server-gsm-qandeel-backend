// HTTP controller of the IP rule routes and the admin access restriction (map domain A, /admin/ip-rules and
// /admin/access/restriction, stage 2). Thin; the rules live in IpRuleAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { IpRuleAdminService } from '../application/ip-rule-admin.service';
import {
  checkIp,
  createIpRule,
  deleteIpRule,
  listIpRules,
  setAdminRestriction,
  showIpRule,
} from '../contracts/ip-rules.contracts';
import { CurrentStaff } from '../security/access-state';
import type { StaffPrincipal } from '../security/principal';

/**
 * The IP rule routes.
 *
 * Why: scenario ip-rules: staff allow and block addresses, test an address, and restrict the console to its allow list.
 *
 * @route GET /admin/ip-rules
 * @route GET /admin/ip-rules/:id
 * @route POST /admin/ip-rules
 * @route DELETE /admin/ip-rules/:id
 * @route POST /admin/ip-rules/check
 * @route PUT /admin/access/restriction
 */
@Controller()
export class IpRulesController {
  constructor(private readonly rules: IpRuleAdminService) {}

  /**
   * Lists the live rules.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/ip-rules
   */
  @Route(listIpRules)
  list(@Query() query: QueryOf<typeof listIpRules>): Promise<ResultOf<typeof listIpRules>> {
    return this.rules.list(query);
  }

  /**
   * Shows a rule.
   *
   * @param params the rule id
   * @returns the rule
   * @route GET /admin/ip-rules/:id
   */
  @Route(showIpRule)
  show(@Param() params: ParamsOf<typeof showIpRule>): Promise<ResultOf<typeof showIpRule>> {
    return this.rules.show(params.id);
  }

  /**
   * Adds a rule.
   *
   * @param caller the signed-in staff member
   * @param body the new rule
   * @returns the rule
   * @route POST /admin/ip-rules
   */
  @Route(createIpRule)
  create(
    @CurrentStaff() caller: StaffPrincipal,
    @Body() body: BodyOf<typeof createIpRule>,
  ): Promise<ResultOf<typeof createIpRule>> {
    return this.rules.create(caller, body);
  }

  /**
   * Removes a rule.
   *
   * @param caller the signed-in staff member
   * @param params the rule id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/ip-rules/:id
   */
  @Route(deleteIpRule)
  remove(@CurrentStaff() caller: StaffPrincipal, @Param() params: ParamsOf<typeof deleteIpRule>): Promise<void> {
    return this.rules.remove(caller, params.id);
  }

  /**
   * Tests an address against the rules.
   *
   * @param body the address and the audience
   * @returns the decision and the rule that made it
   * @route POST /admin/ip-rules/check
   */
  @Route(checkIp)
  check(@Body() body: BodyOf<typeof checkIp>): Promise<ResultOf<typeof checkIp>> {
    return this.rules.check(body);
  }

  /**
   * Turns the admin allow-list restriction on or off.
   *
   * @param caller the signed-in staff member
   * @param body the wanted state
   * @returns the stored state
   * @route PUT /admin/access/restriction
   */
  @Route(setAdminRestriction)
  setRestriction(
    @CurrentStaff() caller: StaffPrincipal,
    @Body() body: BodyOf<typeof setAdminRestriction>,
  ): Promise<ResultOf<typeof setAdminRestriction>> {
    return this.rules.setRestriction(caller, body.enabled);
  }
}
