// The worker processor of the `merchant-webhooks` queue: one catch-all class for the outbox events of merchants (fan-out) and
// for the delivery jobs (one attempt each).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../outbox/outbox.types';
import { WEBHOOK_DELIVER_JOB, type DeliverResult, WebhookDeliveries, type WebhookJobData } from './webhook-deliveries';
import { type FanOutResult, WebhookFanOut } from './webhook-fan-out';

/**
 * Runs the jobs of the `merchant-webhooks` queue.
 *
 * Why: the queue carries two kinds of job. The outbox relay adds one job per merchant event, named by its type
 * (`order.status_changed`, `wallet.low_balance`, ...): this class fans it out to the merchant's endpoints. Fan-out adds
 * `webhook.deliver` jobs, one per attempt of a delivery: this class sends them. A queue cannot have a catch-all processor next to
 * named ones, and the event types are registered by several features, so this is the queue's only processor.
 *
 * @see docs/queues.md (merchant-webhooks)
 */
@Injectable()
@QueueProcessor('merchant-webhooks')
export class MerchantWebhooksProcessor implements JobProcessor<object, FanOutResult | DeliverResult> {
  constructor(
    private readonly fanOut: WebhookFanOut,
    private readonly deliveries: WebhookDeliveries,
  ) {}

  /**
   * Handles one job.
   *
   * @param job a delivery job (`webhook.deliver`) or the outbox job of a merchant event
   * @returns what the fan-out or the delivery did
   */
  process(job: Job<object, FanOutResult | DeliverResult, string>): Promise<FanOutResult | DeliverResult> {
    if (job.name === WEBHOOK_DELIVER_JOB) return this.deliveries.deliver(job.data as WebhookJobData);
    return this.fanOut.run(job.data as OutboxJobData);
  }
}
