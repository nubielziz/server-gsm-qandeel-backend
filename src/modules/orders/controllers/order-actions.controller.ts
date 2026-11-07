// HTTP controller of the staff order actions and the bulk reply (map domain D, stage 5). Thin: it maps the staff member and the
// inputs to OrderActionsService and BulkReplyService.
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { BulkReplyService } from '../application/bulk-reply.service';
import { OrderActionsService } from '../application/order-actions.service';
import {
  acceptOrder,
  addOrderNote,
  applyBulkReply,
  decideVerification,
  previewBulkReply,
  refundOrder,
  rejectOrder,
  reopenOrder,
  replyOrder,
} from '../contracts/order-actions.contracts';

/**
 * The staff order action routes.
 *
 * Why: scenario manual steps 6 to 8 and the order drawer: staff accept, complete, reject, reopen, refund, decide verification and
 * note an order, and complete many at once from a pasted list. Every action goes through the state machine (decision 025).
 *
 * @route POST /admin/orders/:id/accept
 * @route POST /admin/orders/:id/reply
 * @route POST /admin/orders/:id/reject
 * @route POST /admin/orders/:id/reopen
 * @route POST /admin/orders/:id/refund
 * @route POST /admin/orders/:id/verification
 * @route POST /admin/orders/:id/notes
 * @route POST /admin/orders/bulk-reply/preview
 * @route POST /admin/orders/bulk-reply/apply
 */
@Controller()
export class OrderActionsController {
  constructor(
    private readonly actions: OrderActionsService,
    private readonly bulk: BulkReplyService,
  ) {}

  /**
   * Accepts a manual order.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/accept
   */
  @Route(acceptOrder)
  accept(@CurrentStaff() staff: StaffPrincipal, @Param() params: ParamsOf<typeof acceptOrder>): Promise<void> {
    return this.actions.accept(staff, params.id);
  }

  /**
   * Completes an order with its result.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the result text and comment
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/reply
   */
  @Route(replyOrder)
  reply(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof replyOrder>,
    @Body() body: BodyOf<typeof replyOrder>,
  ): Promise<void> {
    return this.actions.reply(staff, params.id, body);
  }

  /**
   * Rejects an order and releases its hold.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the reason
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/reject
   */
  @Route(rejectOrder)
  reject(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof rejectOrder>,
    @Body() body: BodyOf<typeof rejectOrder>,
  ): Promise<void> {
    return this.actions.reject(staff, params.id, body.reason);
  }

  /**
   * Reopens a completed order.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the optional reason
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/reopen
   */
  @Route(reopenOrder)
  reopen(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof reopenOrder>,
    @Body() body: BodyOf<typeof reopenOrder>,
  ): Promise<void> {
    return this.actions.reopen(staff, params.id, body.reason);
  }

  /**
   * Refunds a completed merchant order.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the reason
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/refund
   */
  @Route(refundOrder)
  refund(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof refundOrder>,
    @Body() body: BodyOf<typeof refundOrder>,
  ): Promise<void> {
    return this.actions.refund(staff, params.id, body.reason);
  }

  /**
   * Decides a verification request.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the decision and the optional note
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/verification
   */
  @Route(decideVerification)
  verification(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof decideVerification>,
    @Body() body: BodyOf<typeof decideVerification>,
  ): Promise<void> {
    return this.actions.decideVerification(staff, params.id, body.decision, body.note);
  }

  /**
   * Adds an internal note.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the note
   * @returns nothing: the answer is `204`
   * @route POST /admin/orders/:id/notes
   */
  @Route(addOrderNote)
  note(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof addOrderNote>,
    @Body() body: BodyOf<typeof addOrderNote>,
  ): Promise<void> {
    return this.actions.addNote(staff, params.id, body.body);
  }

  /**
   * Matches pasted lines to orders.
   *
   * @param body the pasted text
   * @returns one entry per non-blank line
   * @route POST /admin/orders/bulk-reply/preview
   */
  @Route(previewBulkReply)
  preview(@Body() body: BodyOf<typeof previewBulkReply>): Promise<ResultOf<typeof previewBulkReply>> {
    return this.bulk.preview(body.text);
  }

  /**
   * Completes the matched orders.
   *
   * @param staff the signed-in staff member
   * @param body the orders and their codes
   * @returns how many were completed and which were refused
   * @route POST /admin/orders/bulk-reply/apply
   */
  @Route(applyBulkReply)
  apply(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof applyBulkReply>,
  ): Promise<ResultOf<typeof applyBulkReply>> {
    return this.bulk.apply(staff, body.items);
  }
}
