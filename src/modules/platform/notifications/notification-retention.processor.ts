// The worker processor of `notification_retention` on the `maintenance` queue (feature 23, plan section 8.4): daily at 04:20 UTC, or a manual
// run from the console's jobs page.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { type RetentionResult, NotificationRetention } from './notification-retention';

/** The job name of the retention clean-up (also its name in the console's jobs list). */
export const NOTIFICATION_RETENTION_JOB = 'notification_retention';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface NotificationRetentionData {
  readonly runId?: number;
}

/**
 * Runs the notification retention.
 *
 * Why: a daily job: every run is recorded in `job_runs` through the {@link JOB_RUN_RECORDER} port (S8), with the counts it deleted.
 */
@Injectable()
@QueueProcessor('maintenance', NOTIFICATION_RETENTION_JOB)
export class NotificationRetentionProcessor implements JobProcessor<NotificationRetentionData, RetentionResult> {
  constructor(
    private readonly retention: NotificationRetention,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the run deleted
   */
  async process(job: Job<NotificationRetentionData, RetentionResult, string>): Promise<RetentionResult> {
    const recorder = this.recorder();
    if (!recorder) return this.retention.run();
    const runId = job.data.runId;
    let result: RetentionResult = { inboxRead: 0, inboxOld: 0, log: 0 };
    await recorder.run(
      runId === undefined
        ? { job: NOTIFICATION_RETENTION_JOB, trigger: 'schedule' }
        : { job: NOTIFICATION_RETENTION_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.retention.run();
        return { processed: result.inboxRead + result.inboxOld + result.log, result: { ...result } };
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
