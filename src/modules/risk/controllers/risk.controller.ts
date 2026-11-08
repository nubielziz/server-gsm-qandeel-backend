// HTTP controller of the risk routes (map domain K, stage 18): the review queue, the decision on a held order and the rules. Thin:
// the rules live in RiskQueueService, RiskDecisionsService and RiskRules.
import { Body, Controller, Header, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { RiskDecisionsService } from '../application/risk-decisions.service';
import { RiskQueueService } from '../application/risk-queue.service';
import { RiskRules } from '../application/risk-rules.service';
import { approveHeldOrder, getRiskQueue, refundHeldOrder } from '../contracts/risk-queue.contracts';
import { getRiskRules, saveRiskRules } from '../contracts/risk-rules.contracts';

/**
 * The console's Risk page: the queue, the decisions and the rules.
 *
 * Why: orders-suppliers-11, scenario b2c-paid: a paid storefront order the rules hold waits here for a person. The answers are never
 * cached, because staff decide on what they show.
 *
 * @route GET /admin/risk/queue
 * @route POST /admin/risk/orders/:id/approve
 * @route POST /admin/risk/orders/:id/refund
 * @route GET /admin/risk/rules
 * @route PUT /admin/risk/rules
 */
@Controller()
export class RiskController {
  constructor(
    private readonly queue: RiskQueueService,
    private readonly decisions: RiskDecisionsService,
    private readonly rules: RiskRules,
  ) {}

  /**
   * Reads the review queue.
   *
   * @returns the held orders, the 30-day figures and the latest decisions
   * @route GET /admin/risk/queue
   */
  @Route(getRiskQueue)
  @Header('Cache-Control', 'no-store')
  readQueue(): Promise<ResultOf<typeof getRiskQueue>> {
    return this.queue.get();
  }

  /**
   * Approves a held order.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @route POST /admin/risk/orders/:id/approve
   */
  @Route(approveHeldOrder)
  async approve(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof approveHeldOrder>,
  ): Promise<void> {
    await this.decisions.approve(staff.staffId, params.id);
  }

  /**
   * Refunds a held order and optionally blocks the buyer.
   *
   * @param staff the signed-in staff member
   * @param params the order id
   * @param body the reason and the two blocklist switches
   * @route POST /admin/risk/orders/:id/refund
   */
  @Route(refundHeldOrder)
  async refund(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof refundHeldOrder>,
    @Body() body: BodyOf<typeof refundHeldOrder>,
  ): Promise<void> {
    await this.decisions.refund(staff.staffId, params.id, body);
  }

  /**
   * Reads the rules.
   *
   * @returns the eight rules
   * @route GET /admin/risk/rules
   */
  @Route(getRiskRules)
  @Header('Cache-Control', 'no-store')
  readRules(): Promise<ResultOf<typeof getRiskRules>> {
    return this.rules.view();
  }

  /**
   * Saves the rules.
   *
   * @param body the whole set
   * @returns the saved set
   * @route PUT /admin/risk/rules
   */
  @Route(saveRiskRules)
  @Header('Cache-Control', 'no-store')
  saveRules(@Body() body: BodyOf<typeof saveRiskRules>): Promise<ResultOf<typeof saveRiskRules>> {
    return this.rules.save(body.rules);
  }
}
