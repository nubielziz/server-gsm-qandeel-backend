// HTTP controller of the supplier quick add routes (feature 26, B214; routes beyond the map). Thin: the rules live in QuickAddService.
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal, requirePermission } from '../../identity';
import { QuickAddService } from '../application/quick-add.service';
import { listServiceGroups, showQuickAddRun, startQuickAdd } from '../contracts/quick-add.contracts';

/** What putting the services on the shop needs besides the route's own `catalog:create` (feature 31, plan 31 section 5.5). */
const PUBLISH_PERMISSION = 'storefront:publish';

/**
 * The supplier quick add routes.
 *
 * Why: the owner asked (2026-11-11) to add a supplier's services by whole group, or all of them, in the background instead of ticking
 * rows in the import picker. The picker's `POST /admin/suppliers/:id/import` is unchanged.
 *
 * @route GET /admin/suppliers/:id/service-groups
 * @route POST /admin/suppliers/:id/quick-add
 * @route GET /admin/suppliers/:id/quick-add/:runId
 */
@Controller()
export class QuickAddController {
  constructor(private readonly quickAdd: QuickAddService) {}

  /**
   * Lists the supplier's service groups with counts.
   *
   * @param params the supplier id
   * @returns the groups, the totals and the latest run
   * @route GET /admin/suppliers/:id/service-groups
   */
  @Route(listServiceGroups)
  groups(@Param() params: ParamsOf<typeof listServiceGroups>): Promise<ResultOf<typeof listServiceGroups>> {
    return this.quickAdd.groups(params.id);
  }

  /**
   * Starts a quick add.
   *
   * @param staff the signed-in staff member
   * @param params the supplier id
   * @param body the scope, the state the services start in and whether they also go on the shop
   * @returns the run, `queued`
   * @throws {AppError} `FORBIDDEN` naming `storefront:publish` when the body asks to publish and the staff member lacks it (the guard
   *   has checked `catalog:create`)
   * @route POST /admin/suppliers/:id/quick-add
   */
  @Route(startQuickAdd)
  start(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof startQuickAdd>,
    @Body() body: BodyOf<typeof startQuickAdd>,
  ): Promise<ResultOf<typeof startQuickAdd>> {
    // The route's own permission is catalog:create; publishing is a second decision (fact 16), checked before anything is read.
    if (body.publish !== undefined) requirePermission(staff, PUBLISH_PERMISSION);
    return this.quickAdd.start(params.id, body, staff.staffId);
  }

  /**
   * Shows a quick add run.
   *
   * @param params the supplier id and the run id
   * @returns the run
   * @route GET /admin/suppliers/:id/quick-add/:runId
   */
  @Route(showQuickAddRun)
  show(@Param() params: ParamsOf<typeof showQuickAddRun>): Promise<ResultOf<typeof showQuickAddRun>> {
    return this.quickAdd.show(params.id, params.runId);
  }
}
