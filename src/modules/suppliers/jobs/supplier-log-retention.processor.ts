// The worker processor of `supplier_log_retention` on the `maintenance` queue (suppliers module, decision 053): daily at 04:50 UTC, or a manual run.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { SupplierLogRetention } from './supplier-log-retention';

/**
 * The job name of the supplier log retention.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const SUPPLIER_LOG_RETENTION_JOB = 'supplier_log_retention';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface SupplierLogRetentionData {
  readonly runId?: number;
}

/** What the job reports. */
export interface SupplierLogRetentionResult {
  readonly deleted: number;
}

/**
 * Deletes old supplier call logs when the daily tick arrives.
 *
 * Why: decision 053. Every run is recorded in `job_runs` (decision 020) with the number of rows it deleted; `JobRunsService` skips a run while a
 * previous one is still going. The queue's own retry applies when the run throws.
 *
 * Side effects: see {@link SupplierLogRetention}; one `job_runs` row per run.
 */
@Injectable()
@QueueProcessor('maintenance', SUPPLIER_LOG_RETENTION_JOB)
export class SupplierLogRetentionProcessor implements JobProcessor<
  SupplierLogRetentionData,
  SupplierLogRetentionResult
> {
  constructor(
    private readonly retention: SupplierLogRetention,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many log rows were deleted
   */
  async process(
    job: Job<SupplierLogRetentionData, SupplierLogRetentionResult, string>,
  ): Promise<SupplierLogRetentionResult> {
    let deleted = 0;
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: SUPPLIER_LOG_RETENTION_JOB, trigger: 'schedule' } as const)
        : ({ job: SUPPLIER_LOG_RETENTION_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      deleted = (await this.retention.run()).deleted;
      return { processed: deleted, result: { deleted } };
    });
    return { deleted };
  }
}
