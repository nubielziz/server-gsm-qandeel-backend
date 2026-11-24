// HTTP controller of the wallet top-ups for staff (map domain E, stage 8, routes /admin/payments*).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal, customerContactOf } from '../../identity';
import { PaymentReviewService } from '../application/payment-review.service';
import { approvePayment, getPayment, listPayments, rejectPayment } from '../contracts/payments.contracts';

/**
 * Routes of the top-ups.
 *
 * Why: thin layer over {@link PaymentReviewService}.
 *
 * @route GET /admin/payments
 * @route GET /admin/payments/:id
 * @route POST /admin/payments/:id/approve
 * @route POST /admin/payments/:id/reject
 */
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentReviewService) {}

  /**
   * Lists the top-ups.
   *
   * @param query sort, range, filters and search
   * @param staff the signed-in staff member (decides whether an account's address is shown and searched, decision 047)
   * @returns the page of payments
   * @route GET /admin/payments
   */
  @Route(listPayments)
  list(
    @Query() query: QueryOf<typeof listPayments>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof listPayments>> {
    return this.payments.list(query, customerContactOf(staff));
  }

  /**
   * Reads one top-up.
   *
   * @param params the payment id
   * @param staff the signed-in staff member (decides whether an account's address is shown, decision 047)
   * @returns the payment
   * @route GET /admin/payments/:id
   */
  @Route(getPayment)
  show(
    @Param() params: ParamsOf<typeof getPayment>,
    @CurrentStaff() staff: StaffPrincipal,
  ): Promise<ResultOf<typeof getPayment>> {
    return this.payments.get(params.id, customerContactOf(staff));
  }

  /**
   * Approves a top-up and credits the wallet.
   *
   * @param staff the signed-in staff member
   * @param params the payment id
   * @returns the payment after the decision
   * @route POST /admin/payments/:id/approve
   */
  @Route(approvePayment)
  approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof approvePayment>,
  ): Promise<ResultOf<typeof approvePayment>> {
    return this.payments.approve(staff, params.id);
  }

  /**
   * Rejects a top-up with a reason.
   *
   * @param staff the signed-in staff member
   * @param params the payment id
   * @param body the reason the account sees
   * @returns the payment after the decision
   * @route POST /admin/payments/:id/reject
   */
  @Route(rejectPayment)
  reject(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof rejectPayment>,
    @Body() body: BodyOf<typeof rejectPayment>,
  ): Promise<ResultOf<typeof rejectPayment>> {
    return this.payments.reject(staff, params.id, body.reason);
  }
}
