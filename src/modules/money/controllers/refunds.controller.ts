// HTTP controller of the storefront refunds for staff (map domain E, stage 16, routes /admin/refunds*).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { RefundService } from '../application/refund.service';
import { approveRefund, declineRefund, getRefund, listRefunds, retryRefund } from '../contracts/refunds.contracts';

/**
 * Routes of the storefront refunds.
 *
 * Why: thin layer over {@link RefundService}.
 *
 * @route GET /admin/refunds
 * @route GET /admin/refunds/:id
 * @route POST /admin/refunds/:id/approve
 * @route POST /admin/refunds/:id/decline
 * @route POST /admin/refunds/:id/retry
 */
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundService) {}

  /**
   * Lists the refunds.
   *
   * @param query sort, range, filters and search
   * @returns the page of refunds
   * @route GET /admin/refunds
   */
  @Route(listRefunds)
  list(@Query() query: QueryOf<typeof listRefunds>): Promise<ResultOf<typeof listRefunds>> {
    return this.refunds.list(query);
  }

  /**
   * Reads one refund.
   *
   * @param params the refund id
   * @returns the refund
   * @route GET /admin/refunds/:id
   */
  @Route(getRefund)
  show(@Param() params: ParamsOf<typeof getRefund>): Promise<ResultOf<typeof getRefund>> {
    return this.refunds.get(params.id);
  }

  /**
   * Approves a refund.
   *
   * @param staff the signed-in staff member
   * @param params the refund id
   * @param body the optional amount
   * @returns the refund after the decision
   * @route POST /admin/refunds/:id/approve
   */
  @Route(approveRefund)
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof approveRefund>,
    @Body() body: BodyOf<typeof approveRefund>,
  ): Promise<ResultOf<typeof approveRefund>> {
    return this.refunds.approve(staff.staffId, params.id, body.amount);
  }

  /**
   * Declines a refund with a reason for the customer.
   *
   * @param staff the signed-in staff member
   * @param params the refund id
   * @param body the reason
   * @returns the refund after the decision
   * @route POST /admin/refunds/:id/decline
   */
  @Route(declineRefund)
  decline(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof declineRefund>,
    @Body() body: BodyOf<typeof declineRefund>,
  ): Promise<ResultOf<typeof declineRefund>> {
    return this.refunds.decline(staff.staffId, params.id, body.reason);
  }

  /**
   * Sends a failed refund to the gateway again.
   *
   * @param params the refund id
   * @returns the refund, processing again
   * @route POST /admin/refunds/:id/retry
   */
  @Route(retryRefund)
  retry(@Param() params: ParamsOf<typeof retryRefund>): Promise<ResultOf<typeof retryRefund>> {
    return this.refunds.retry(params.id);
  }
}
