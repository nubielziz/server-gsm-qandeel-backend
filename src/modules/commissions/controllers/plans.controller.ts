// HTTP controller of the commission plan routes (map domain F, /admin/commission-plans*, stage 11). Thin: the rules live in PlanAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { PlanAdminService } from '../application/plan-admin.service';
import {
  createCommissionPlan,
  deleteCommissionPlan,
  listCommissionPlans,
  showCommissionPlan,
  updateCommissionPlan,
} from '../contracts/plans.contracts';

/**
 * The commission plan routes.
 *
 * Why: the console's Commissions page, Plans tab: referral and rebate plans and their rates.
 *
 * @route GET /admin/commission-plans
 * @route GET /admin/commission-plans/:id
 * @route POST /admin/commission-plans
 * @route PATCH /admin/commission-plans/:id
 * @route DELETE /admin/commission-plans/:id
 */
@Controller()
export class PlansController {
  constructor(private readonly plans: PlanAdminService) {}

  /**
   * Lists plans.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/commission-plans
   */
  @Route(listCommissionPlans)
  list(@Query() query: QueryOf<typeof listCommissionPlans>): Promise<ResultOf<typeof listCommissionPlans>> {
    return this.plans.list(query);
  }

  /**
   * Shows a plan.
   *
   * @param params the plan id
   * @returns the plan
   * @route GET /admin/commission-plans/:id
   */
  @Route(showCommissionPlan)
  show(@Param() params: ParamsOf<typeof showCommissionPlan>): Promise<ResultOf<typeof showCommissionPlan>> {
    return this.plans.get(params.id);
  }

  /**
   * Adds a plan.
   *
   * @param body the plan fields
   * @returns the new plan
   * @route POST /admin/commission-plans
   */
  @Route(createCommissionPlan)
  create(@Body() body: BodyOf<typeof createCommissionPlan>): Promise<ResultOf<typeof createCommissionPlan>> {
    return this.plans.create(body);
  }

  /**
   * Changes a plan.
   *
   * @param params the plan id
   * @param body the keys to change
   * @returns the updated plan
   * @route PATCH /admin/commission-plans/:id
   */
  @Route(updateCommissionPlan)
  update(
    @Param() params: ParamsOf<typeof updateCommissionPlan>,
    @Body() body: BodyOf<typeof updateCommissionPlan>,
  ): Promise<ResultOf<typeof updateCommissionPlan>> {
    return this.plans.update(params.id, body);
  }

  /**
   * Deletes a plan nothing refers to.
   *
   * @param params the plan id
   * @returns nothing: the answer is `204`
   * @route DELETE /admin/commission-plans/:id
   */
  @Route(deleteCommissionPlan)
  remove(@Param() params: ParamsOf<typeof deleteCommissionPlan>): Promise<void> {
    return this.plans.remove(params.id);
  }
}
