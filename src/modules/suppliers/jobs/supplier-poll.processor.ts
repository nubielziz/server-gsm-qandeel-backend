// The worker jobs of the supplier-poll queue (suppliers module): the tick that finds the sent orders due for a poll, and one status poll.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../infra/queues';
import {
  type CheckOutcome,
  SUPPLIER_POLL_JOB,
  type SupplierPollJobData,
  SupplierPoll,
} from '../application/supplier-poll';

/**
 * Runs the poll jobs.
 *
 * Why: scenario success step 8. The queue has this one processor for two job names (a catch-all cannot sit next to named processors):
 * `supplier_poll_tick` (a scheduler, every minute) queues a `poll` job per due order, and `poll` asks one supplier about one order.
 * Neither is recorded in `job_runs`: both are high-frequency housekeeping whose health shows in the queue metrics.
 */
@Injectable()
@QueueProcessor('supplier-poll')
export class SupplierPollProcessor implements JobProcessor<object, CheckOutcome | { due: number; queued: number }> {
  constructor(private readonly poll: SupplierPoll) {}

  /**
   * Handles one job.
   *
   * @param job a `poll` job (data `{ orderId }`) or the tick
   * @returns what the tick queued, or what the supplier said
   */
  process(job: Job<object, CheckOutcome | { due: number; queued: number }, string>) {
    if (job.name === SUPPLIER_POLL_JOB) {
      const orderId = (job.data as SupplierPollJobData).orderId;
      if (typeof orderId !== 'number') throw new UnrecoverableError('The poll job has no order id.');
      return this.poll.check(orderId, { type: 'system' });
    }
    return this.poll.tick();
  }
}
