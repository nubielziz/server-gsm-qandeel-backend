// The worker job that promotes merchants by spend (identity module, queue maintenance, job client_group_promotion).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { GroupPromotion, type PromotionSummary } from './group-promotion';

/**
 * The job name of the nightly promotion.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name of the console's jobs list
 * (`GET /admin/system/jobs`).
 */
export const GROUP_PROMOTION_JOB = 'client_group_promotion';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface GroupPromotionData {
  readonly runId?: number;
}

/**
 * Promotes merchants when the nightly tick arrives.
 *
 * Why: user rule 1 asks for a nightly promotion by spend. The run is recorded in `job_runs` (decision 020), and `JobRunsService`
 * skips it while a previous run is still going.
 */
@Injectable()
@QueueProcessor('maintenance', GROUP_PROMOTION_JOB)
export class GroupPromotionProcessor implements JobProcessor<GroupPromotionData, PromotionSummary> {
  constructor(
    private readonly promotion: GroupPromotion,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many merchants were checked, promoted and skipped
   */
  async process(job: Job<GroupPromotionData, PromotionSummary, string>): Promise<PromotionSummary> {
    let summary: PromotionSummary = { checked: 0, promoted: 0, skipped: 0 };
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: GROUP_PROMOTION_JOB, trigger: 'schedule' } as const)
        : ({ job: GROUP_PROMOTION_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      summary = await this.promotion.run();
      return { processed: summary.promoted, result: { ...summary } };
    });
    return summary;
  }
}
