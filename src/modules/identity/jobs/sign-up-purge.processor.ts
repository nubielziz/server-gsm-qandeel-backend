// The worker job that deletes the waiting sign-up forms whose link can no longer be used (identity module, queue maintenance, job
// sign_up_purge; decision 079).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { SessionPurge } from './session-purge';

/**
 * The job name of the purge of lapsed sign-up forms.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name the console's jobs list shows.
 */
export const SIGN_UP_PURGE_JOB = 'sign_up_purge';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface SignUpPurgeData {
  readonly runId?: number;
}

/** What the job reports. */
export interface SignUpPurgeResult {
  readonly deleted: number;
}

/**
 * Deletes, every 15 minutes, the waiting sign-up forms (`account_signups`, with the argon2id hash of a chosen password) whose link expired,
 * was used or was voided.
 *
 * Why: the review of decision 079 (S5): nothing with a password hash may outlive its link for long. The exchange deletes every form of
 * its address, and a deleted link takes its form with it; a link that is never opened, or one voided by another flow, leaves its form
 * until this run (at most an hour and a quarter after the mail). The daily `session_purge` does the same pass once more. Safe to repeat and
 * to run in parallel: the delete only takes rows whose link can no longer be exchanged. The run is recorded in `job_runs` (decision 020),
 * and `JobRunsService` skips it while a previous run is still going.
 */
@Injectable()
@QueueProcessor('maintenance', SIGN_UP_PURGE_JOB)
export class SignUpPurgeProcessor implements JobProcessor<SignUpPurgeData, SignUpPurgeResult> {
  constructor(
    private readonly purge: SessionPurge,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many waiting forms were deleted
   */
  async process(job: Job<SignUpPurgeData, SignUpPurgeResult, string>): Promise<SignUpPurgeResult> {
    let deleted = 0;
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: SIGN_UP_PURGE_JOB, trigger: 'schedule' } as const)
        : ({ job: SIGN_UP_PURGE_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      deleted = await this.purge.purgeLapsedSignUps();
      return { processed: deleted, result: { deleted } };
    });
    return { deleted };
  }
}
