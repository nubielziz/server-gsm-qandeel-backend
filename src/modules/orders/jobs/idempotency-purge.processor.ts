// The worker job that forgets old REST v1 Idempotency-Keys (orders module, queue maintenance, job idempotency_purge).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { IdempotencyPurge } from './idempotency-purge';

/**
 * The job name of the daily purge.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name the console's jobs list shows.
 */
export const IDEMPOTENCY_PURGE_JOB = 'idempotency_purge';

/**
 * The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted.
 *
 * Why: the job carries ids only (no secrets or personal data), and a manual run must update the `job_runs` row that the console's jobs list
 * shows as running, instead of inserting a second row (decision 020).
 */
export interface IdempotencyPurgeData {
  readonly runId?: number;
}

/**
 * What the job reports.
 *
 * Why: B166. The same two counts go to `job_runs.result` and (as their sum) to `processed`, so the jobs list shows how much a night's purge
 * forgot: `answers` stored replays deleted, `orderKeys` orders whose key was freed.
 */
export interface IdempotencyPurgeResult {
  readonly answers: number;
  readonly orderKeys: number;
}

/**
 * Purges expired Idempotency-Keys when the daily tick arrives.
 *
 * Why: B166. The run is recorded in `job_runs` (decision 020): `processed` is the answers deleted plus the order keys cleared, and
 * `result` is `{ answers, orderKeys }`. `JobRunsService` skips it while a previous run is still going.
 */
@Injectable()
@QueueProcessor('maintenance', IDEMPOTENCY_PURGE_JOB)
export class IdempotencyPurgeProcessor implements JobProcessor<IdempotencyPurgeData, IdempotencyPurgeResult> {
  constructor(
    private readonly purge: IdempotencyPurge,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many answers were deleted and how many order keys cleared
   */
  async process(job: Job<IdempotencyPurgeData, IdempotencyPurgeResult, string>): Promise<IdempotencyPurgeResult> {
    let count: IdempotencyPurgeResult = { answers: 0, orderKeys: 0 };
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: IDEMPOTENCY_PURGE_JOB, trigger: 'schedule' } as const)
        : ({ job: IDEMPOTENCY_PURGE_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      count = await this.purge.purge();
      return { processed: count.answers + count.orderKeys, result: { ...count } };
    });
    return count;
  }
}
