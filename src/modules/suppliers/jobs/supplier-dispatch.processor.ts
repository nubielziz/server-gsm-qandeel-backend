// The worker job that sends an order to its supplier (suppliers module, queue supplier-dispatch, outbox event order.dispatch_requested).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { type DispatchOutcome, SupplierDispatch } from '../application/supplier-dispatch';

/**
 * Runs the dispatch job.
 *
 * Why: the orders feature writes `order.dispatch_requested` (payload `{ orderId }`) when an automatic order is placed or staff send one
 * again; the relay turns it into a job of this queue. This is the queue's only processor, so it handles every job name. A busy supplier
 * throws (the queue retries with backoff); a payload without an order id can never succeed (`UnrecoverableError`).
 */
@Injectable()
@QueueProcessor('supplier-dispatch')
export class SupplierDispatchProcessor implements JobProcessor<OutboxJobData, DispatchOutcome> {
  constructor(private readonly dispatch: SupplierDispatch) {}

  /**
   * Handles one dispatch job.
   *
   * @param job the outbox job
   * @returns what the dispatch did
   */
  process(job: Job<OutboxJobData, DispatchOutcome, string>): Promise<DispatchOutcome> {
    const orderId = job.data.payload?.orderId;
    if (typeof orderId !== 'number') throw new UnrecoverableError('The dispatch job has no order id.');
    const attempts = job.opts.attempts ?? 1;
    return this.dispatch.run(orderId, { lastAttempt: job.attemptsMade + 1 >= attempts });
  }
}
