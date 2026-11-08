// The worker processors of the `notifications` queue that belong to feature 12a: planning an outbox event into notifications and sending
// one notification row. The merchant mails keep their own named processors in the identity module.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../infra/queues';
import { EventNotifier, NOTIFICATION_PLAN_JOB, NOTIFICATION_SEND_JOB, type PlanResult } from './event-notifier';
import { NotificationDelivery, type DeliveryOutcome } from './notification-delivery';
import type { OutboxJobData } from '../outbox/outbox.types';

/**
 * Plans the notifications of an outbox event.
 *
 * Why: `order.status_changed`, `wallet.low_balance` and `service.price_changed` are routed here (job `notification.plan`), next to the
 * merchant webhooks; `EventNotifier` decides who is told.
 */
@Injectable()
@QueueProcessor('notifications', NOTIFICATION_PLAN_JOB)
export class NotificationPlanProcessor implements JobProcessor<OutboxJobData, PlanResult> {
  constructor(private readonly notifier: EventNotifier) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns what was planned
   */
  process(job: Job<OutboxJobData, PlanResult, string>): Promise<PlanResult> {
    return this.notifier.plan(job.data);
  }
}

/** The data of a `notification.send` job: from the relay (the row is the aggregate) or a delayed digest job (`notificationId`). */
type SendJobData = Partial<OutboxJobData> & { readonly notificationId?: number };

/**
 * Sends one notification row.
 *
 * Why: the row exists (`queued`) before the job does, in the transaction that made it. The job id says which occurrence it is
 * (`outbox-<event id>`, or `notification-<id>` for a digest), so the queue never holds two jobs for one send; `NotificationDelivery` guards
 * the row, so a job that runs twice records one send.
 */
@Injectable()
@QueueProcessor('notifications', NOTIFICATION_SEND_JOB)
export class NotificationSendProcessor implements JobProcessor<SendJobData, DeliveryOutcome> {
  constructor(private readonly delivery: NotificationDelivery) {}

  /**
   * Handles one job.
   *
   * @param job the send job
   * @returns what the attempt did
   * @throws {UnrecoverableError} when the job names no notification (a programming error)
   * @throws {DeliveryError} for a transient failure, so the queue retries (5 attempts, 30 s backoff)
   */
  process(job: Job<SendJobData, DeliveryOutcome, string>): Promise<DeliveryOutcome> {
    const id = typeof job.data.notificationId === 'number' ? job.data.notificationId : job.data.aggregateId;
    if (typeof id !== 'number') throw new UnrecoverableError('A notification.send job names no notification.');
    return this.delivery.deliver(id, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 });
  }
}
