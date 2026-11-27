// The worker job that sends an order to its supplier (suppliers module, queue supplier-dispatch, outbox event order.dispatch_requested).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DelayedError, type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { type DispatchOutcome, SupplierDispatch } from '../application/supplier-dispatch';

/**
 * Runs the dispatch job.
 *
 * Why: the orders feature writes `order.dispatch_requested` (payload `{ orderId }`) when an automatic order is placed or staff send one
 * again (or the dispatch sweep asks again for a lost request, decision 044); the relay turns it into a job of this queue. This is the
 * queue's only processor, so it handles every job name. A busy supplier, or call limits that cannot be read, throw (the queue retries with
 * backoff; the last attempt ends in `needs_attention`); a payload without an order id can never succeed (`UnrecoverableError`). An order
 * inside its cancel window (decision 075) is not sent yet: the job moves itself to `delayed` until the window ends
 * (`job.moveToDelayed(until, token)`, then `DelayedError`), so it runs again then with no attempt used up and nothing counted as failed.
 */
@Injectable()
@QueueProcessor('supplier-dispatch')
export class SupplierDispatchProcessor implements JobProcessor<OutboxJobData, DispatchOutcome> {
  constructor(private readonly dispatch: SupplierDispatch) {}

  /**
   * Handles one dispatch job.
   *
   * @param job the outbox job
   * @param token the worker's lock token of this run (needed to move the job to `delayed`)
   * @returns what the dispatch did
   * @throws {DelayedError} after moving the job to `delayed` until the end of the order's cancel window (BullMQ runs it again then)
   */
  async process(job: Job<OutboxJobData, DispatchOutcome, string>, token?: string): Promise<DispatchOutcome> {
    const orderId = job.data.payload?.orderId;
    if (typeof orderId !== 'number') throw new UnrecoverableError('The dispatch job has no order id.');
    const attempts = job.opts.attempts ?? 1;
    const outcome = await this.dispatch.run(orderId, { lastAttempt: job.attemptsMade + 1 >= attempts });
    if (outcome.status !== 'deferred') return outcome;
    // The run wrote nothing: the job waits in `delayed` (it stays live for the dispatch sweep) and runs again at the end of the window.
    await job.moveToDelayed(outcome.until.getTime(), token);
    throw new DelayedError();
  }
}
