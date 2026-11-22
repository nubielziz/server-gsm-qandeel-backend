// The worker processor of `outbox_purge` on the `maintenance` queue (platform module, decision 055): daily at 04:50 UTC, or a manual run.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { OUTBOX_RETENTION_DAYS, OutboxPurge } from './outbox-purge';

/**
 * The job name of the outbox purge (also its name in the console's jobs list).
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it.
 */
export const OUTBOX_PURGE_JOB = 'outbox_purge';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface OutboxPurgeData {
  readonly runId?: number;
}

/**
 * Runs the outbox purge.
 *
 * Why: decision 055. A daily job is recorded on every run (`processed` = rows deleted, `result` = `{ deleted, batches, retentionDays }`)
 * through the {@link JOB_RUN_RECORDER} port (platform cannot import health).
 */
@Injectable()
@QueueProcessor('maintenance', OUTBOX_PURGE_JOB)
export class OutboxPurgeProcessor implements JobProcessor<OutboxPurgeData, { deleted: number; batches: number }> {
  constructor(
    private readonly purge: OutboxPurge,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many rows were deleted, in how many statements
   */
  async process(
    job: Pick<Job<OutboxPurgeData, { deleted: number; batches: number }, string>, 'data'>,
  ): Promise<{ deleted: number; batches: number }> {
    const runId = job.data.runId;
    const recorder = this.recorder();
    if (!recorder) return this.purge.run();
    let result = { deleted: 0, batches: 0 };
    await recorder.run(
      runId === undefined
        ? { job: OUTBOX_PURGE_JOB, trigger: 'schedule' }
        : { job: OUTBOX_PURGE_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.purge.run();
        return { processed: result.deleted, result: { ...result, retentionDays: OUTBOX_RETENTION_DAYS } };
      },
    );
    return result;
  }

  /** The health module's recorder, when this process loaded it (the worker always does). */
  private recorder(): JobRunRecorder | undefined {
    try {
      return this.moduleRef.get<JobRunRecorder>(JOB_RUN_RECORDER, { strict: false });
    } catch {
      return undefined;
    }
  }
}
