// HTTP controller of the card disputes for staff and the dispute webhook (map domain E, stage 16).
import { Body, Controller, Param, Query } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, CurrentStaff, type Principal, type StaffPrincipal } from '../../identity';
import { DisputeService } from '../application/dispute.service';
import { DisputeWebhookService } from '../application/dispute-webhook.service';
import {
  acceptDispute,
  disputeWebhook,
  getDispute,
  listDisputes,
  submitDisputeEvidence,
} from '../contracts/disputes.contracts';

/**
 * Routes of the disputes and of the gateway's dispute events.
 *
 * Why: thin layer over {@link DisputeService} and {@link DisputeWebhookService}; the gateway signature guard has already verified a webhook
 * delivery.
 *
 * @route GET /admin/disputes
 * @route GET /admin/disputes/:id
 * @route POST /admin/disputes/:id/evidence
 * @route POST /admin/disputes/:id/accept
 * @route POST /webhooks/disputes/:gateway
 */
@Controller()
export class DisputesController {
  constructor(
    private readonly disputes: DisputeService,
    private readonly webhook: DisputeWebhookService,
  ) {}

  /**
   * Lists the disputes.
   *
   * @param query sort, range, filters and search
   * @returns the page of disputes
   * @route GET /admin/disputes
   */
  @Route(listDisputes)
  list(@Query() query: QueryOf<typeof listDisputes>): Promise<ResultOf<typeof listDisputes>> {
    return this.disputes.list(query);
  }

  /**
   * Reads one dispute with its evidence pack.
   *
   * @param params the dispute id
   * @returns the dispute
   * @route GET /admin/disputes/:id
   */
  @Route(getDispute)
  show(@Param() params: ParamsOf<typeof getDispute>): Promise<ResultOf<typeof getDispute>> {
    return this.disputes.get(params.id);
  }

  /**
   * Submits evidence.
   *
   * @param staff the signed-in staff member
   * @param params the dispute id
   * @param body the chosen lines and the note
   * @returns the dispute under review
   * @route POST /admin/disputes/:id/evidence
   */
  @Route(submitDisputeEvidence)
  evidence(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof submitDisputeEvidence>,
    @Body() body: BodyOf<typeof submitDisputeEvidence>,
  ): Promise<ResultOf<typeof submitDisputeEvidence>> {
    return this.disputes.submitEvidence(staff.staffId, params.id, body);
  }

  /**
   * Accepts the loss.
   *
   * @param staff the signed-in staff member
   * @param params the dispute id
   * @returns the dispute, lost
   * @route POST /admin/disputes/:id/accept
   */
  @Route(acceptDispute)
  accept(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof acceptDispute>,
  ): Promise<ResultOf<typeof acceptDispute>> {
    return this.disputes.accept(staff.staffId, params.id);
  }

  /**
   * Records a verified dispute event.
   *
   * @param principal the verified webhook delivery
   * @param body the gateway's event
   * @returns `{ received: true }`
   * @route POST /webhooks/disputes/:gateway
   */
  @Route(disputeWebhook)
  hook(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof disputeWebhook>,
  ): Promise<ResultOf<typeof disputeWebhook>> {
    if (principal?.kind !== 'webhook') throw new AppError('WEBHOOK_SIGNATURE_INVALID');
    return this.webhook.handle(principal.gateway, body);
  }
}
