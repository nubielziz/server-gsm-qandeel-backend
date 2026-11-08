// The worker job that erases old IMEIs (risk module, queue maintenance, job data_retention).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { ImeiRetention } from './imei-retention';

/**
 * The job name of the nightly retention run.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is the console's job name (`GET /admin/system/jobs`).
 */
export const DATA_RETENTION_JOB = 'data_retention';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface DataRetentionData {
  readonly runId?: number;
}

/** What the job reports. */
export interface DataRetentionResult {
  readonly erased: number;
}

/**
 * Erases the IMEI of the checks past the retention period when the nightly tick arrives.
 *
 * Why: RESOLUTIONS b2c-4 and the privacy promise. The run is recorded in `job_runs` (decision 020); `JobRunsService` skips it while
 * a previous run is still going. The job carries no data: it reads the setting and the clock itself.
 */
@Injectable()
@QueueProcessor('maintenance', DATA_RETENTION_JOB)
export class DataRetentionProcessor implements JobProcessor<DataRetentionData, DataRetentionResult> {
  constructor(
    private readonly retention: ImeiRetention,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many checks were erased
   */
  async process(job: Job<DataRetentionData, DataRetentionResult, string>): Promise<DataRetentionResult> {
    let erased = 0;
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: DATA_RETENTION_JOB, trigger: 'schedule' } as const)
        : ({ job: DATA_RETENTION_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      const outcome = await this.retention.run();
      erased = outcome.erased;
      return { processed: erased, result: { days: outcome.days, erased } };
    });
    return { erased };
  }
}
