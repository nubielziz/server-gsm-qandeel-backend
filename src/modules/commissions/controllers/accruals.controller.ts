// HTTP controller of the commission accrual routes (map domain F, /admin/commission-accruals*, stage 11). Thin: the rules live in
// AccrualReader and AccrualApproval.
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { AccrualApproval } from '../application/accrual-approval.service';
import { AccrualReader } from '../application/accrual-reader.service';
import {
  approveCommissionAccruals,
  listCommissionAccruals,
  showCommissionAccrual,
} from '../contracts/accruals.contracts';

/**
 * The commission accrual routes.
 *
 * Why: the console's Commissions page, Accruals tab: what agents earned and the bulk approval that pays it into their wallets.
 *
 * @route GET /admin/commission-accruals
 * @route GET /admin/commission-accruals/:id
 * @route POST /admin/commission-accruals/approve
 */
@Controller()
export class AccrualsController {
  constructor(
    private readonly reader: AccrualReader,
    private readonly approval: AccrualApproval,
  ) {}

  /**
   * Lists accruals.
   *
   * @param query the parsed list request
   * @returns the rows and the total
   * @route GET /admin/commission-accruals
   */
  @Route(listCommissionAccruals)
  list(@Query() query: QueryOf<typeof listCommissionAccruals>): Promise<ResultOf<typeof listCommissionAccruals>> {
    return this.reader.list(query);
  }

  /**
   * Shows an accrual.
   *
   * @param params the accrual id
   * @returns the accrual
   * @route GET /admin/commission-accruals/:id
   */
  @Route(showCommissionAccrual)
  show(@Param() params: ParamsOf<typeof showCommissionAccrual>): Promise<ResultOf<typeof showCommissionAccrual>> {
    return this.reader.get(params.id);
  }

  /**
   * Approves accruals and pays them into the agents' wallets.
   *
   * @param staff the staff member approving
   * @param body the accrual ids
   * @returns how many were approved, the money posted and the skipped ones
   * @route POST /admin/commission-accruals/approve
   */
  @Route(approveCommissionAccruals)
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof approveCommissionAccruals>,
  ): Promise<ResultOf<typeof approveCommissionAccruals>> {
    return this.approval.approve(staff.staffId, body.ids);
  }
}
