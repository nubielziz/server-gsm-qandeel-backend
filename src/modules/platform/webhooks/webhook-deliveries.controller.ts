// HTTP controller of the staff's webhook log (map domain G, stage 7): /admin/webhook-deliveries. Thin; the rules live in
// WebhookDeliveryAdminService. The merchant portal's routes under /client/webhooks are served by identity's
// `MerchantWebhooksController`, because they need identity's merchant decorator and platform imports no module (decision 032).
import { Controller, Param, Query } from '@nestjs/common';
import { type ParamsOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { WebhookDeliveryAdminService } from './webhook-delivery-admin.service';
import { listWebhookDeliveries, retryWebhookDelivery, showWebhookDelivery } from './webhook-deliveries.contracts';

/**
 * The staff's webhook log routes.
 *
 * Why: the console's Webhook deliveries tab reads what was sent to merchants and resends a delivery that failed.
 *
 * @route GET /admin/webhook-deliveries
 * @route GET /admin/webhook-deliveries/:id
 * @route POST /admin/webhook-deliveries/:id/retry
 */
@Controller()
export class WebhookDeliveriesController {
  constructor(private readonly deliveries: WebhookDeliveryAdminService) {}

  /**
   * Lists deliveries.
   *
   * @param query the parsed list request
   * @returns the rows and the exact total
   * @route GET /admin/webhook-deliveries
   */
  @Route(listWebhookDeliveries)
  list(@Query() query: QueryOf<typeof listWebhookDeliveries>): Promise<ResultOf<typeof listWebhookDeliveries>> {
    return this.deliveries.list(query);
  }

  /**
   * Shows one delivery.
   *
   * @param params the delivery id
   * @returns the delivery with its request and the merchant's answer
   * @route GET /admin/webhook-deliveries/:id
   */
  @Route(showWebhookDelivery)
  show(@Param() params: ParamsOf<typeof showWebhookDelivery>): Promise<ResultOf<typeof showWebhookDelivery>> {
    return this.deliveries.show(params.id);
  }

  /**
   * Sends a delivery again.
   *
   * @param params the delivery id
   * @returns the delivery after it was queued
   * @route POST /admin/webhook-deliveries/:id/retry
   */
  @Route(retryWebhookDelivery)
  retry(@Param() params: ParamsOf<typeof retryWebhookDelivery>): Promise<ResultOf<typeof retryWebhookDelivery>> {
    return this.deliveries.retry(params.id);
  }
}
