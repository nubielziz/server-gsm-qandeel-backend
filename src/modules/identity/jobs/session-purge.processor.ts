// The worker job that purges old ended sessions (identity module, queue maintenance, job session_purge).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { SessionPurge } from './session-purge';

/**
 * The job name of the daily purge.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name the console's jobs list shows.
 */
export const SESSION_PURGE_JOB = 'session_purge';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface SessionPurgeData {
  readonly runId?: number;
}

/** What the job reports. */
export interface SessionPurgeResult {
  readonly deleted: number;
}

/**
 * Purges ended sessions when the daily tick arrives.
 *
 * Why: scenario admin-team and ip-rules keep ended sessions readable for 30 days; after that they only cost space. The run is
 * recorded in `job_runs` (decision 020), and `JobRunsService` skips it while a previous run is still going.
 */
@Injectable()
@QueueProcessor('maintenance', SESSION_PURGE_JOB)
export class SessionPurgeProcessor implements JobProcessor<SessionPurgeData, SessionPurgeResult> {
  constructor(
    private readonly purge: SessionPurge,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns how many sessions were deleted
   */
  async process(job: Job<SessionPurgeData, SessionPurgeResult, string>): Promise<SessionPurgeResult> {
    let deleted = 0;
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: SESSION_PURGE_JOB, trigger: 'schedule' } as const)
        : ({ job: SESSION_PURGE_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      deleted = await this.purge.purge();
      return { processed: deleted, result: { deleted } };
    });
    return { deleted };
  }
}
