// The worker processor of `webhook_delivery_retention` on the `maintenance` queue (decision 053): daily at 04:40 UTC, or a manual run.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { WebhookDeliveryRetention } from './webhook-delivery-retention';

/** The job name of the delivery retention (also its name in the console's jobs list). */
export const WEBHOOK_DELIVERY_RETENTION_JOB = 'webhook_delivery_retention';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface WebhookDeliveryRetentionData {
  readonly runId?: number;
}

/** What the job reports. */
export interface WebhookDeliveryRetentionResult {
  readonly deleted: number;
}

/**
 * Runs the webhook delivery retention.
 *
 * Why: decision 053. A daily job; every run is recorded in `job_runs` through the {@link JOB_RUN_RECORDER} port with the number of rows it
 * deleted. The queue's own retry applies when the run throws.
 *
 * Side effects: see {@link WebhookDeliveryRetention}; one `job_runs` row per run.
 */
@Injectable()
@QueueProcessor('maintenance', WEBHOOK_DELIVERY_RETENTION_JOB)
export class WebhookDeliveryRetentionProcessor implements JobProcessor<
  WebhookDeliveryRetentionData,
  WebhookDeliveryRetentionResult
> {
  constructor(
    private readonly retention: WebhookDeliveryRetention,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many deliveries were deleted
   */
  async process(
    job: Job<WebhookDeliveryRetentionData, WebhookDeliveryRetentionResult, string>,
  ): Promise<WebhookDeliveryRetentionResult> {
    const recorder = this.recorder();
    if (!recorder) return this.retention.run();
    const runId = job.data.runId;
    let result: WebhookDeliveryRetentionResult = { deleted: 0 };
    await recorder.run(
      runId === undefined
        ? { job: WEBHOOK_DELIVERY_RETENTION_JOB, trigger: 'schedule' }
        : { job: WEBHOOK_DELIVERY_RETENTION_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.retention.run();
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
