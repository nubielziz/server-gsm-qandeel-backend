// HTTP controller of the commission assignment routes (map domain F, /admin/commission-assignments*, stage 11). Thin: the rules live in
// AssignmentAdminService.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AssignmentAdminService } from '../application/assignment-admin.service';
import {
  createCommissionAssignment,
  deleteCommissionAssignment,
  listCommissionAssignments,
  showCommissionAssignment,
  updateCommissionAssignment,
} from '../contracts/assignments.contracts';

/**
 * The commission assignment routes.
 *
 * Why: the console's Commissions page, Agents tab: which merchants are on which plan.
 *
 * @route GET /admin/commission-assignments
 * @route GET /admin/commission-assignments/:id
 * @route POST /admin/commission-assignments
 * @route PATCH /admin/commission-assignments/:id
 * @route DELETE /admin/commission-assignments/:id
 */
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentAdminService) {}

  /**
   * Lists assignments.
   *
   * @param query the parsed list request, `includeEnded` among the extra parameters
   * @returns the rows and the total
   * @route GET /admin/commission-assignments
   */
  @Route(listCommissionAssignments)
  list(@Query() query: QueryOf<typeof listCommissionAssignments>): Promise<ResultOf<typeof listCommissionAssignments>> {
    return this.assignments.list(query, query.extra.includeEnded === 'true');
  }

  /**
   * Shows an assignment.
   *
   * @param params the assignment id
   * @returns the assignment
   * @route GET /admin/commission-assignments/:id
   */
  @Route(showCommissionAssignment)
  show(@Param() params: ParamsOf<typeof showCommissionAssignment>): Promise<ResultOf<typeof showCommissionAssignment>> {
    return this.assignments.get(params.id);
  }

  /**
   * Puts a merchant on a plan.
   *
   * @param body the merchant and the plan
   * @returns the new assignment
   * @route POST /admin/commission-assignments
   */
  @Route(createCommissionAssignment)
  create(
    @Body() body: BodyOf<typeof createCommissionAssignment>,
  ): Promise<ResultOf<typeof createCommissionAssignment>> {
    return this.assignments.create(body);
  }

  /**
   * Moves a merchant to another plan.
   *
   * @param params the assignment id
   * @param body the new plan
   * @returns the new assignment
   * @route PATCH /admin/commission-assignments/:id
   */
  @Route(updateCommissionAssignment)
  update(
    @Param() params: ParamsOf<typeof updateCommissionAssignment>,
    @Body() body: BodyOf<typeof updateCommissionAssignment>,
  ): Promise<ResultOf<typeof updateCommissionAssignment>> {
    return this.assignments.update(params.id, body);
  }

  /**
   * Ends an assignment.
   *
   * @param params the assignment id
   * @returns nothing: the answer is `204`
   * @route DELETE /admin/commission-assignments/:id
   */
  @Route(deleteCommissionAssignment)
  remove(@Param() params: ParamsOf<typeof deleteCommissionAssignment>): Promise<void> {
    return this.assignments.end(params.id);
  }
}
