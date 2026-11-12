// HTTP controller of the supplier quick add routes (feature 26, B214; routes beyond the map). Thin: the rules live in QuickAddService.
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { QuickAddService } from '../application/quick-add.service';
import { listServiceGroups, showQuickAddRun, startQuickAdd } from '../contracts/quick-add.contracts';

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
   * @param body the scope and the state the services start in
   * @returns the run, `queued`
   * @route POST /admin/suppliers/:id/quick-add
   */
  @Route(startQuickAdd)
  start(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof startQuickAdd>,
    @Body() body: BodyOf<typeof startQuickAdd>,
  ): Promise<ResultOf<typeof startQuickAdd>> {
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
