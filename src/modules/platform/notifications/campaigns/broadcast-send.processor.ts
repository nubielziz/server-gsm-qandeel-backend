// The worker processor of the bulk queue `notification-broadcasts` (feature 23, plan section 8.2): one campaign email or Telegram
// message per job, after its per-channel budget, through the one delivery path of the notifications.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../../infra/queues';
import { DeliveryError } from '../delivery-error';
import { type AttemptContext, type DeliveryOutcome, NotificationDelivery } from '../notification-delivery';
import { BroadcastBudget } from './broadcast-budget';

/** The bulk queue of the campaigns. */
export const BROADCAST_QUEUE = 'notification-broadcasts';
/** The job name of one campaign message. */
export const BROADCAST_SEND_JOB = 'notification.send';
/** A provider's "retry after" this short is waited for inside the same attempt (a Telegram 429). */
export const INLINE_RETRY_MAX_SECONDS = 30;

/** The data of a bulk send job: the row and its channel (ids and a code only). */
export interface BroadcastSendData {
  readonly notificationId: number;
  readonly channel: 'email' | 'telegram';
}

/**
 * Sends one campaign message.
 *
 * Why: the fan-out made the row (`queued`) and added this job with the id `notification-<row id>`, so the queue holds one job per
 * message. The queue's limiter caps the jobs (30 a second); the budget caps each channel at the providers' rate (O8). The delivery
 * guards the row, so a job that runs twice records one send; a short "retry after" from Telegram is waited for once in the same
 * attempt, anything else goes to the queue's backoff (6 attempts, from 60 s).
 */
@Injectable()
@QueueProcessor(BROADCAST_QUEUE, BROADCAST_SEND_JOB)
export class BroadcastSendProcessor implements JobProcessor<BroadcastSendData, DeliveryOutcome> {
  constructor(
    private readonly delivery: NotificationDelivery,
    private readonly budget: BroadcastBudget,
  ) {}

  /**
   * Handles one job.
   *
   * @param job the send job
   * @returns what the attempt did
   * @throws {UnrecoverableError} when the job names no row or no channel (a programming error)
   * @throws {DeliveryError} for a transient failure, so the queue retries
   */
  async process(job: Job<BroadcastSendData, DeliveryOutcome, string>): Promise<DeliveryOutcome> {
    const { notificationId, channel } = job.data;
    if (typeof notificationId !== 'number' || (channel !== 'email' && channel !== 'telegram'))
      throw new UnrecoverableError('A notification-broadcasts job needs a notification id and a channel.');
    const context: AttemptContext = { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 };
    if (await this.delivery.mayStillSend(notificationId)) await this.budget.take(channel);
    try {
      return await this.delivery.deliver(notificationId, context);
    } catch (error) {
      const retryAfter = error instanceof DeliveryError ? error.retryAfterSeconds : undefined;
      const short = retryAfter !== undefined && retryAfter <= INLINE_RETRY_MAX_SECONDS;
      // On the last attempt the delivery already marked the row failed; the queue's backoff takes every other error.
      if (!short || context.attempt >= context.maxAttempts) throw error;
      await this.budget.wait(retryAfter * 1000);
      return this.delivery.deliver(notificationId, context);
    }
  }
}
