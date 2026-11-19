// The worker job of the follow pass (catalog module, queue maintenance, job retail_price_follow, plan 31 section 6.4).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { RETAIL_FOLLOW_JOB } from '../application/retail-follow-scheduler';
import { NO_FOLLOW_RESULT, RetailPriceFollow, type RetailFollowResult } from '../application/retail-price-follow';

/** The job data: empty for the delayed job and the schedule; a manual run carries the `job_runs` row it inserted. */
export interface RetailFollowJobData {
  readonly runId?: number;
}

/**
 * Runs the follow pass.
 *
 * Why: plan 31 sections 6 and 6.4 and its correction 6: the same pass has three starts. The delayed job that follows a price change is
 * event-driven and runs unrecorded (at most one a minute, like the price change scan). The hourly scheduler (`job.repeatJobKey` marks
 * its jobs) and a manual run from the Jobs tab (`data.runId`) are recorded in `job_runs`, as every scheduled job is; a scheduled run
 * that meets another one running is recorded as skipped.
 */
@Injectable()
@QueueProcessor('maintenance', RETAIL_FOLLOW_JOB)
export class RetailPriceFollowProcessor implements JobProcessor<RetailFollowJobData, RetailFollowResult> {
  constructor(
    private readonly follow: RetailPriceFollow,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one job.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the pass did (nothing when a scheduled run was skipped)
   */
  async process(job: Job<RetailFollowJobData, RetailFollowResult, string>): Promise<RetailFollowResult> {
    const { runId } = job.data;
    if (runId === undefined && job.repeatJobKey === undefined) return this.follow.run();
    const options =
      runId === undefined
        ? ({ job: RETAIL_FOLLOW_JOB, trigger: 'schedule' } as const)
        : ({ job: RETAIL_FOLLOW_JOB, trigger: 'manual', runId } as const);
    let outcome = NO_FOLLOW_RESULT;
    await this.runs.run(options, async () => {
      outcome = await this.follow.run();
      return { processed: outcome.checked, result: { ...outcome } };
    });
    return outcome;
  }
}
