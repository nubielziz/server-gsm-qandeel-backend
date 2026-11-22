// HTTP controller of the storefront payments held for staff (decision 048, a route beyond the map: scripts/map-additions/38.mjs).
import { Body, Controller, Param } from '@nestjs/common';
import { type BodyOf, type ParamsOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { HeldPaymentsService } from '../application/held-payments.service';
import { closeHeldPayment } from '../contracts/held-payments.contracts';

/**
 * Routes of the storefront payments held for staff.
 *
 * Why: thin layer over {@link HeldPaymentsService} (decision 048: the smallest staff action that closes a held payment).
 *
 * @route POST /admin/held-payments/:id/close
 */
@Controller()
export class HeldPaymentsController {
  constructor(private readonly held: HeldPaymentsService) {}

  /**
   * Closes a held payment: paid back by hand, or no money was received.
   *
   * @param staff the signed-in staff member
   * @param params the payment id
   * @param body the outcome and staff's note
   * @returns resolves once the payment is closed (`204`)
   * @route POST /admin/held-payments/:id/close
   */
  @Route(closeHeldPayment)
  close(
    @CurrentStaff() staff: StaffPrincipal,
    @Param() params: ParamsOf<typeof closeHeldPayment>,
    @Body() body: BodyOf<typeof closeHeldPayment>,
  ): Promise<void> {
    return this.held.close(staff.staffId, params.id, body);
  }
}
