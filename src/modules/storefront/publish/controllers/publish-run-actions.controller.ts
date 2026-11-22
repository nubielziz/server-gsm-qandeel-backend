// HTTP controller of what staff do to a publish run (feature 31, plan 31 section 5.2, /admin/publish-runs): edit a row, change many rows,
// apply, cancel and switch. Thin: the rules live in PublishItemEditService and PublishRunAdminService; the controller reads the role for
// the second permissions of plan 31 section 5.1 (fact 16).
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../../common/contract';
import { CurrentStaff, type StaffPrincipal, grants } from '../../../identity';
import { PublishItemEditService } from '../application/publish-item-edit.service';
import { PRICE_PERMISSION, PUBLISH_PERMISSION, missingPermission } from '../application/publish-permissions';
import { PublishRunAdminService } from '../application/publish-run-admin.service';
import {
  applyPublishRun,
  bulkEditPublishItems,
  cancelPublishRun,
  editPublishItem,
  switchPublishRun,
} from '../contracts/publish-run-actions.contracts';
import { editsPrice } from '../domain/publish-edit';

/**
 * The routes that change a publish run or its rows.
 *
 * Why: staff correct a preview, publish it, stop it or take it off the shop. Each route has one permission the guard checks; the price
 * keys of a row edit (and a reset that would drop a price staff chose) also need `pricing:update` (the permission of a retail price on the listing route, decision 046) and stopping a run that is publishing also needs `storefront:publish`.
 *
 * @route PATCH /admin/publish-runs/:id/items/:itemId
 * @route POST /admin/publish-runs/:id/items/bulk
 * @route POST /admin/publish-runs/:id/apply
 * @route POST /admin/publish-runs/:id/cancel
 * @route POST /admin/publish-runs/:id/listed
 */
@Controller()
export class PublishRunActionsController {
  constructor(
    private readonly edits: PublishItemEditService,
    private readonly runs: PublishRunAdminService,
  ) {}

  /**
   * Edits one row of a draft.
   *
   * @param params the run and the row
   * @param body what to change
   * @param staff the signed-in staff member (the role is read for the price keys)
   * @returns the row, judged again
   * @throws {AppError} `FORBIDDEN` (403: a price key, or a reset that drops a price staff chose, needs `pricing:update`)
   * @route PATCH /admin/publish-runs/:id/items/:itemId
   */
  @Route(editPublishItem)
  edit(
    @Param() params: ParamsOf<typeof editPublishItem>,
    @Body() body: BodyOf<typeof editPublishItem>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof editPublishItem>> {
    const canPrice = grants(staff.permissions, PRICE_PERMISSION);
    if (editsPrice(body) && !canPrice) throw missingPermission(PRICE_PERMISSION);
    return this.edits.edit(params.id, params.itemId, body, canPrice);
  }

  /**
   * Changes the tick or the facts of many rows of a draft.
   *
   * @param params the run
   * @param body the rows and what to set
   * @returns how many rows changed and how many were refused
   * @route POST /admin/publish-runs/:id/items/bulk
   */
  @Route(bulkEditPublishItems)
  bulk(
    @Param() params: ParamsOf<typeof bulkEditPublishItems>,
    @Body() body: BodyOf<typeof bulkEditPublishItems>,
  ): Promise<ResultOf<typeof bulkEditPublishItems>> {
    return this.edits.bulk(params.id, body.select, body.set);
  }

  /**
   * Applies a run: publishes the ticked rows, or continues a run that stopped.
   *
   * @param params the run
   * @param body how the run publishes (`listed`)
   * @returns the run, `queued`
   * @route POST /admin/publish-runs/:id/apply
   */
  @Route(applyPublishRun)
  apply(
    @Param() params: ParamsOf<typeof applyPublishRun>,
    @Body() body: BodyOf<typeof applyPublishRun>,
  ): Promise<ResultOf<typeof applyPublishRun>> {
    return this.runs.apply(params.id, body);
  }

  /**
   * Cancels a preview or a run.
   *
   * @param params the run
   * @param staff the signed-in staff member (the role is read when the run is publishing)
   * @returns the run, `cancelled`
   * @route POST /admin/publish-runs/:id/cancel
   */
  @Route(cancelPublishRun)
  cancel(
    @Param() params: ParamsOf<typeof cancelPublishRun>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof cancelPublishRun>> {
    return this.runs.cancel(params.id, grants(staff.permissions, PUBLISH_PERMISSION));
  }

  /**
   * Takes what a run published off the shop, or puts it back.
   *
   * @param params the run
   * @param body the target
   * @param staff the signed-in staff member (the audit rows of the listings carry them)
   * @returns the run, with its switch `queued`
   * @route POST /admin/publish-runs/:id/listed
   */
  @Route(switchPublishRun)
  switchListed(
    @Param() params: ParamsOf<typeof switchPublishRun>,
    @Body() body: BodyOf<typeof switchPublishRun>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof switchPublishRun>> {
    return this.runs.setListed(staff.staffId, params.id, body.listed);
  }
}
