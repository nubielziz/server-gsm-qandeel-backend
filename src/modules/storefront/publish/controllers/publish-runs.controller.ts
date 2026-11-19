// HTTP controller of the bulk publish's draft routes (feature 31, plan 31 section 5.2, /admin/publish-runs): create a run, list the
// runs, show one and list its rows. Thin: the rules live in PublishRunAdminService. The edit, apply, cancel and switch routes are slice B4b.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../../identity';
import { PublishRunAdminService } from '../application/publish-run-admin.service';
import {
  createPublishRun,
  listPublishItems,
  listPublishRuns,
  showPublishRun,
} from '../contracts/publish-runs.contracts';

/**
 * The publish run routes of the draft.
 *
 * Why: staff put services on the shop in bulk through a preview they can read and correct before anything is published.
 *
 * @route POST /admin/publish-runs
 * @route GET /admin/publish-runs
 * @route GET /admin/publish-runs/:id
 * @route GET /admin/publish-runs/:id/items
 */
@Controller()
export class PublishRunsController {
  constructor(private readonly runs: PublishRunAdminService) {}

  /**
   * Prepares a draft of the services of a scope.
   *
   * @param body the scope and, optionally, whether apply switches the listings on
   * @param staff the signed-in staff member (the run's `requestedBy`)
   * @returns the new run (`preparing`)
   * @route POST /admin/publish-runs
   */
  @Route(createPublishRun)
  create(
    @Body() body: BodyOf<typeof createPublishRun>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof createPublishRun>> {
    return this.runs.create(staff.staffId, body);
  }

  /**
   * Lists publish runs.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/publish-runs
   */
  @Route(listPublishRuns)
  list(@Query() query: QueryOf<typeof listPublishRuns>): Promise<ResultOf<typeof listPublishRuns>> {
    return this.runs.list(query);
  }

  /**
   * Shows a publish run.
   *
   * @param params the run id
   * @returns the run
   * @route GET /admin/publish-runs/:id
   */
  @Route(showPublishRun)
  show(@Param() params: ParamsOf<typeof showPublishRun>): Promise<ResultOf<typeof showPublishRun>> {
    return this.runs.show(params.id);
  }

  /**
   * Lists the rows of a publish run.
   *
   * @param params the run id
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/publish-runs/:id/items
   */
  @Route(listPublishItems)
  items(
    @Param() params: ParamsOf<typeof listPublishItems>,
    @Query() query: QueryOf<typeof listPublishItems>,
  ): Promise<ResultOf<typeof listPublishItems>> {
    return this.runs.items(params.id, query);
  }
}
