// The worker job of the supplier quick add (suppliers module, queue imports): `supplier_quick_add` runs one `supplier_import_runs` row.
// It is an outbox event, so the job carries the run id and the supplier id only.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { SUPPLIER_QUICK_ADD_JOB } from '../application/quick-add-outbox';
import { type QuickAddOutcome, QuickAddRunner } from '../application/quick-add-runner';

/**
 * Runs the supplier quick add jobs.
 *
 * Why: feature 26 (B214): `POST /admin/suppliers/:id/quick-add` writes the run and the `supplier.quick_add` outbox row in one commit; this
 * job adds the services in chunks. The queue gives it one attempt and never re-runs a stalled job (`imports`), and the runner is
 * idempotent: only a `queued` run is claimed. The job id is the outbox row's (`outbox-<id>`).
 */
@Injectable()
@QueueProcessor('imports', SUPPLIER_QUICK_ADD_JOB)
export class QuickAddProcessor implements JobProcessor<OutboxJobData, QuickAddOutcome> {
  constructor(private readonly runner: QuickAddRunner) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`aggregateId` is the run)
   * @returns how the run ended
   * @throws {UnrecoverableError} when the job carries no run id
   */
  process(job: Job<OutboxJobData, QuickAddOutcome, string>): Promise<QuickAddOutcome> {
    const runId = job.data.aggregateId;
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1) {
      throw new UnrecoverableError('The supplier_quick_add job has no run id.');
    }
    return this.runner.run(runId);
  }
}
