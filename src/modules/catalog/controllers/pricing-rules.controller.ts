// HTTP controller of the pricing rule routes (map domain B, /admin/pricing-rules, stage 4). Thin: the rules live in
// PricingRuleAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { PricingRuleAdminService } from '../application/pricing-rule-admin.service';
import {
  createPricingRule,
  deletePricingRule,
  listPricingRules,
  showPricingRule,
  updatePricingRule,
} from '../contracts/pricing-rules.contracts';

/**
 * The pricing rule routes.
 *
 * Why: staff add margins, discounts and promos that the price resolver applies to new orders.
 *
 * @route GET /admin/pricing-rules
 * @route GET /admin/pricing-rules/:id
 * @route POST /admin/pricing-rules
 * @route PATCH /admin/pricing-rules/:id
 * @route DELETE /admin/pricing-rules/:id
 */
@Controller()
export class PricingRulesController {
  constructor(private readonly rules: PricingRuleAdminService) {}

  /**
   * Lists pricing rules.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/pricing-rules
   */
  @Route(listPricingRules)
  list(@Query() query: QueryOf<typeof listPricingRules>): Promise<ResultOf<typeof listPricingRules>> {
    return this.rules.list(query);
  }

  /**
   * Shows a pricing rule.
   *
   * @param params the rule id
   * @returns the rule
   * @route GET /admin/pricing-rules/:id
   */
  @Route(showPricingRule)
  show(@Param() params: ParamsOf<typeof showPricingRule>): Promise<ResultOf<typeof showPricingRule>> {
    return this.rules.show(params.id);
  }

  /**
   * Creates a pricing rule.
   *
   * @param body the whole rule
   * @returns the new rule
   * @route POST /admin/pricing-rules
   */
  @Route(createPricingRule)
  create(@Body() body: BodyOf<typeof createPricingRule>): Promise<ResultOf<typeof createPricingRule>> {
    return this.rules.create(body);
  }

  /**
   * Changes a pricing rule.
   *
   * @param params the rule id
   * @param body the keys to change
   * @returns the updated rule
   * @route PATCH /admin/pricing-rules/:id
   */
  @Route(updatePricingRule)
  update(
    @Param() params: ParamsOf<typeof updatePricingRule>,
    @Body() body: BodyOf<typeof updatePricingRule>,
  ): Promise<ResultOf<typeof updatePricingRule>> {
    return this.rules.update(params.id, body);
  }

  /**
   * Deletes a pricing rule.
   *
   * @param params the rule id
   * @returns nothing: the route answers 204
   * @route DELETE /admin/pricing-rules/:id
   */
  @Route(deletePricingRule)
  remove(@Param() params: ParamsOf<typeof deletePricingRule>): Promise<void> {
    return this.rules.remove(params.id);
  }
}
