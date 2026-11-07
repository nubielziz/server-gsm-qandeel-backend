// HTTP controller of the incoming payment confirmation (map domain E, stage 8, route POST /webhooks/payments/:gateway).
import { Body, Controller } from '@nestjs/common';
import { type BodyOf, type ResultOf, Route } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { CurrentPrincipal, type Principal } from '../../identity';
import { PaymentWebhookService } from '../application/payment-webhook.service';
import { paymentWebhook } from '../contracts/payment-webhook.contracts';

/**
 * The route gateways call to confirm a payment.
 *
 * Why: thin layer over {@link PaymentWebhookService}; the gateway signature guard has already verified the delivery.
 *
 * @route POST /webhooks/payments/:gateway
 */
@Controller()
export class PaymentWebhookController {
  constructor(private readonly webhook: PaymentWebhookService) {}

  /**
   * Records a verified payment confirmation.
   *
   * @param principal the verified webhook delivery
   * @param body the gateway's event
   * @returns `{ received: true }`
   * @route POST /webhooks/payments/:gateway
   */
  @Route(paymentWebhook)
  confirm(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: BodyOf<typeof paymentWebhook>,
  ): Promise<ResultOf<typeof paymentWebhook>> {
    if (principal?.kind !== 'webhook') throw new AppError('WEBHOOK_SIGNATURE_INVALID');
    return this.webhook.handle(principal.gateway, body);
  }
}
