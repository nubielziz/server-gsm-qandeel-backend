// HTTP controller of the retail price rule routes (feature 31, decision 040, spec B229, /admin/retail-price-rules). Thin: the
// rules live in RetailPriceRuleAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { RetailPriceRuleAdminService } from '../application/retail-price-rule-admin.service';
import {
  createRetailPriceRule,
  deleteRetailPriceRule,
  listRetailPriceRules,
  previewRetailPriceRule,
  updateRetailPriceRule,
} from '../contracts/retail-price-rules.contracts';

/**
 * The retail price rule routes.
 *
 * Why: decision 040: staff price the shop by rules that follow the supplier's cost, and see what a change would do first.
 *
 * @route GET /admin/retail-price-rules
 * @route POST /admin/retail-price-rules
 * @route PATCH /admin/retail-price-rules/:id
 * @route DELETE /admin/retail-price-rules/:id
 * @route POST /admin/retail-price-rules/preview
 */
@Controller()
export class RetailPriceRulesController {
  constructor(private readonly rules: RetailPriceRuleAdminService) {}

  /**
   * Lists the retail price rules.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/retail-price-rules
   */
  @Route(listRetailPriceRules)
  list(@Query() query: QueryOf<typeof listRetailPriceRules>): Promise<ResultOf<typeof listRetailPriceRules>> {
    return this.rules.list(query);
  }

  /**
   * Previews a change of the rules (nothing is stored).
   *
   * @param body the change
   * @returns the counts and the largest changes
   * @route POST /admin/retail-price-rules/preview
   */
  @Route(previewRetailPriceRule)
  preview(@Body() body: BodyOf<typeof previewRetailPriceRule>): Promise<ResultOf<typeof previewRetailPriceRule>> {
    return this.rules.preview(body.change);
  }

  /**
   * Creates a retail price rule.
   *
   * @param staff the signed-in staff member
   * @param body the rule
   * @returns the new rule
   * @route POST /admin/retail-price-rules
   */
  @Route(createRetailPriceRule)
  create(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof createRetailPriceRule>,
  ): Promise<ResultOf<typeof createRetailPriceRule>> {
    return this.rules.create(staff.staffId, body);
  }

  /**
   * Changes a retail price rule.
   *
   * @param staff the signed-in staff member
   * @param params the rule id
   * @param body the figures to change
   * @returns the updated rule
   * @route PATCH /admin/retail-price-rules/:id
   */
  @Route(updateRetailPriceRule)
  update(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof updateRetailPriceRule>,
    @Body() body: BodyOf<typeof updateRetailPriceRule>,
  ): Promise<ResultOf<typeof updateRetailPriceRule>> {
    return this.rules.update(staff.staffId, params.id, body);
  }

  /**
   * Deletes a retail price rule (a soft delete).
   *
   * @param staff the signed-in staff member
   * @param params the rule id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/retail-price-rules/:id
   */
  @Route(deleteRetailPriceRule)
  remove(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof deleteRetailPriceRule>,
  ): Promise<void> {
    return this.rules.remove(staff.staffId, params.id);
  }
}
