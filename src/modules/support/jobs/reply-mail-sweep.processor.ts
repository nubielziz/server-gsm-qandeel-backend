// The worker job of the support chat's email fallback (support module, queue maintenance, job support_reply_mail_sweep): every minute it
// mails the unseen email replies whose delay is over (ReplyMailSweep).
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { ReplyMailSweep, type ReplyMailSweepResult } from '../application/reply-mail-sweep';

/**
 * The job name of the email fallback.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const SUPPORT_REPLY_MAIL_SWEEP_JOB = 'support_reply_mail_sweep';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface ReplyMailSweepData {
  readonly runId?: number;
}

const NOTHING: ReplyMailSweepResult = { tickets: 0, mailed: 0, seen: 0 };

/**
 * Runs the email fallback when the schedule ticks.
 *
 * Why: feature 28, rule 9. Recorded like `checkout_recovery_sweep`: a tick with nothing due writes no `job_runs` row (a run every minute
 * with nothing to do would bury the jobs list); a tick that finds due tickets, and every manual run, is recorded with its counts. The job
 * carries no data: it reads the clock and the tickets itself, and a repeat finds nothing left to mail (the sweep clears what it handled).
 */
@Injectable()
@QueueProcessor('maintenance', SUPPORT_REPLY_MAIL_SWEEP_JOB)
export class ReplyMailSweepProcessor implements JobProcessor<ReplyMailSweepData, ReplyMailSweepResult> {
  constructor(
    private readonly sweep: ReplyMailSweep,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the sweep did
   */
  async process(job: Job<ReplyMailSweepData, ReplyMailSweepResult, string>): Promise<ReplyMailSweepResult> {
    const runId = job.data.runId;
    if (runId === undefined && !(await this.sweep.due())) return NOTHING;
    let summary = NOTHING;
    const options =
      runId === undefined
        ? ({ job: SUPPORT_REPLY_MAIL_SWEEP_JOB, trigger: 'schedule' } as const)
        : ({ job: SUPPORT_REPLY_MAIL_SWEEP_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      summary = await this.sweep.run();
      return { processed: summary.mailed, result: { ...summary } };
    });
    return summary;
  }
}
