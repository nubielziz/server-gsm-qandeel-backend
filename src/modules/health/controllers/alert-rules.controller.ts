// HTTP controller of the alert rule routes (map domain G, /admin/alert-rules*, feature 12b). Thin: the rules live in AlertRulesService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { AlertRulesService } from '../application/alert-rules.service';
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  showAlertRule,
  updateAlertRule,
} from '../contracts/alert-rules.contracts';

/**
 * The alert rule routes.
 *
 * Why: the console's Alerts and incidents tab edits the rules the evaluator watches.
 *
 * @route GET /admin/alert-rules
 * @route GET /admin/alert-rules/:id
 * @route POST /admin/alert-rules
 * @route PATCH /admin/alert-rules/:id
 * @route DELETE /admin/alert-rules/:id
 */
@Controller()
export class AlertRulesController {
  constructor(private readonly rules: AlertRulesService) {}

  /**
   * Lists the rules.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/alert-rules
   */
  @Route(listAlertRules)
  list(@Query() query: QueryOf<typeof listAlertRules>): Promise<ResultOf<typeof listAlertRules>> {
    return this.rules.list(query);
  }

  /**
   * Shows a rule.
   *
   * @param params the rule id
   * @returns the rule
   * @route GET /admin/alert-rules/:id
   */
  @Route(showAlertRule)
  show(@Param() params: ParamsOf<typeof showAlertRule>): Promise<ResultOf<typeof showAlertRule>> {
    return this.rules.show(params.id);
  }

  /**
   * Adds a rule.
   *
   * @param staff the signed-in staff member
   * @param body the rule's fields
   * @returns the new rule
   * @route POST /admin/alert-rules
   */
  @Route(createAlertRule)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createAlertRule>,
  ): Promise<ResultOf<typeof createAlertRule>> {
    return this.rules.create(staff.staffId, body);
  }

  /**
   * Changes a rule.
   *
   * @param staff the signed-in staff member
   * @param params the rule id
   * @param body the fields to change
   * @returns the updated rule
   * @route PATCH /admin/alert-rules/:id
   */
  @Route(updateAlertRule)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateAlertRule>,
    @Body() body: BodyOf<typeof updateAlertRule>,
  ): Promise<ResultOf<typeof updateAlertRule>> {
    return this.rules.update(staff.staffId, params.id, body);
  }

  /**
   * Deletes a rule.
   *
   * @param staff the signed-in staff member
   * @param params the rule id
   * @returns nothing: the answer is `204`
   * @route DELETE /admin/alert-rules/:id
   */
  @Route(deleteAlertRule)
  remove(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof deleteAlertRule>): Promise<void> {
    return this.rules.remove(staff.staffId, params.id);
  }
}
