// The worker processor of `upload_janitor` on the `maintenance` queue (decision 053): daily at 04:30 UTC, or a manual run from the console's jobs page.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { type UploadJanitorResult, UploadJanitor } from './upload-janitor';

/** The job name of the upload janitor (also its name in the console's jobs list). */
export const UPLOAD_JANITOR_JOB = 'upload_janitor';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface UploadJanitorData {
  readonly runId?: number;
}

/**
 * Runs the upload janitor.
 *
 * Why: decision 053. A daily job; every run is recorded in `job_runs` through the {@link JOB_RUN_RECORDER} port with the counts it deleted and
 * kept. The queue's own retry applies when the run throws.
 *
 * Side effects: see {@link UploadJanitor}; one `job_runs` row per run.
 */
@Injectable()
@QueueProcessor('maintenance', UPLOAD_JANITOR_JOB)
export class UploadJanitorProcessor implements JobProcessor<UploadJanitorData, UploadJanitorResult> {
  constructor(
    private readonly janitor: UploadJanitor,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the run deleted and kept
   */
  async process(job: Job<UploadJanitorData, UploadJanitorResult, string>): Promise<UploadJanitorResult> {
    const recorder = this.recorder();
    if (!recorder) return this.janitor.run();
    const runId = job.data.runId;
    let result: UploadJanitorResult = { deleted: 0, kept: 0 };
    await recorder.run(
      runId === undefined
        ? { job: UPLOAD_JANITOR_JOB, trigger: 'schedule' }
        : { job: UPLOAD_JANITOR_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.janitor.run();
        return { processed: result.deleted, result: { ...result } };
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
