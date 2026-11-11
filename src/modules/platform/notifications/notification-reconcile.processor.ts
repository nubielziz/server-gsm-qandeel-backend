// The worker processor of `notification_reconcile` on the `maintenance` queue (feature 23, plan section 8.4): every 5 minutes, or a manual run
// from the console's jobs page.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { type ReconcileResult, NotificationReconcile } from './notification-reconcile';

/** The job name of the reconciler (also its name in the console's jobs list). */
export const NOTIFICATION_RECONCILE_JOB = 'notification_reconcile';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface NotificationReconcileData {
  readonly runId?: number;
}

const NOTHING: ReconcileResult = { campaignRows: 0, eventRows: 0, digests: 0, expired: 0 };

/**
 * Runs the notification reconciler.
 *
 * Why: a run that finds nothing writes no `job_runs` row (a run every 5 minutes would bury the jobs list, the rule of the campaign sweep);
 * a run that touched something, and every manual run, is recorded through the {@link JOB_RUN_RECORDER} port (S8).
 */
@Injectable()
@QueueProcessor('maintenance', NOTIFICATION_RECONCILE_JOB)
export class NotificationReconcileProcessor implements JobProcessor<NotificationReconcileData, ReconcileResult> {
  constructor(
    private readonly reconcile: NotificationReconcile,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the run did
   */
  async process(job: Job<NotificationReconcileData, ReconcileResult, string>): Promise<ReconcileResult> {
    const runId = job.data.runId;
    if (runId === undefined && !(await this.reconcile.hasWork())) return NOTHING;
    const recorder = this.recorder();
    if (!recorder) return this.reconcile.run();
    let result = NOTHING;
    await recorder.run(
      runId === undefined
        ? { job: NOTIFICATION_RECONCILE_JOB, trigger: 'schedule' }
        : { job: NOTIFICATION_RECONCILE_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.reconcile.run();
        return {
          processed: result.campaignRows + result.eventRows + result.digests + result.expired,
          result: { ...result },
        };
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
