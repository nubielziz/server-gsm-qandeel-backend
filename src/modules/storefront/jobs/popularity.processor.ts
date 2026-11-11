// The worker job that refreshes the storefront popularity counts (storefront module, queue maintenance, job storefront_popularity).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { type PopularityResult, PopularityRefresh } from './popularity';

/**
 * The job name of the popularity refresh.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name the console's jobs list shows.
 */
export const STOREFRONT_POPULARITY_JOB = 'storefront_popularity';

/**
 * The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted (ids only, decision 020).
 */
export interface PopularityData {
  readonly runId?: number;
}

/**
 * Refreshes the popularity counts when the 30-minute tick arrives.
 *
 * Why: feature 22. The run is recorded in `job_runs`: `processed` is the number of listing rows that changed and `result` is
 * `{ services, changed }`. `JobRunsService` skips it while a previous run is still going.
 */
@Injectable()
@QueueProcessor('maintenance', STOREFRONT_POPULARITY_JOB)
export class PopularityProcessor implements JobProcessor<PopularityData, PopularityResult> {
  constructor(
    private readonly popularity: PopularityRefresh,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns the refresh figures
   */
  async process(job: Job<PopularityData, PopularityResult, string>): Promise<PopularityResult> {
    let outcome: PopularityResult = { services: 0, changed: 0 };
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: STOREFRONT_POPULARITY_JOB, trigger: 'schedule' } as const)
        : ({ job: STOREFRONT_POPULARITY_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      outcome = await this.popularity.refresh();
      return { processed: outcome.changed, result: { ...outcome } };
    });
    return outcome;
  }
}
