// The worker job of storefront refunds (money module, queue maintenance): `refund.process` sends an approved refund to its gateway.
// It is an outbox event, so the job carries the refund id only.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type { OutboxJobData } from '../../platform';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { REFUND_PROCESS_EVENT } from '../application/refund-outbox';
import { type RefundSendResult, RefundSender } from './refund-sender';

/** True when this run is the queue's last attempt. */
function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Reads the id a payload carries. */
function idOf(job: Job<OutboxJobData>, key: string): number {
  const value = (job.data.payload as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new UnrecoverableError(`The ${job.name} job has no ${key}.`);
  }
  return value;
}

/**
 * Sends approved refunds to their gateways.
 *
 * Why: scenario b2c-refund step 6: the API writes the `refund.process` outbox row in the approval's transaction and this job makes the
 * gateway call with an idempotency key, so a retry never refunds twice. The job id is the outbox row's (`outbox-<id>`).
 */
@Injectable()
@QueueProcessor('maintenance', REFUND_PROCESS_EVENT)
export class RefundProcessProcessor implements JobProcessor<OutboxJobData, RefundSendResult> {
  constructor(private readonly sender: RefundSender) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`payload.refundId`)
   * @returns what happened to the refund
   */
  process(job: Job<OutboxJobData, RefundSendResult, string>): Promise<RefundSendResult> {
    return this.sender.send(idOf(job, 'refundId'), isFinalAttempt(job));
  }
}
