// The worker processors of the abandoned-checkout recovery (customers module, feature 19): the mail of one checkout (queue
// notifications) and the automatic reminder's tick (queue maintenance).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import type { OutboxJobData } from '../../platform';
import { CHECKOUT_RECOVERY_EVENT } from '../application/recovery-outbox';
import { type RecoveryMailResult, RecoveryMail } from '../application/recovery-mail';
import { type SweepSummary, RecoverySweep } from '../application/recovery-sweep';

/**
 * Sends the recovery email of one checkout.
 *
 * Why: `POST /admin/checkouts/recover` and the automatic reminder write `checkout.recovery` once the checkout is claimed; this job
 * makes the mail. The queue is `notifications`, so its policy applies (5 attempts, backoff from 30 s); the job name is the event type.
 */
@Injectable()
@QueueProcessor('notifications', CHECKOUT_RECOVERY_EVENT)
export class CheckoutRecoveryProcessor implements JobProcessor<OutboxJobData, RecoveryMailResult> {
  constructor(private readonly mail: RecoveryMail) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job
   * @returns whether the mail was handed over
   */
  process(job: Job<OutboxJobData, RecoveryMailResult, string>): Promise<RecoveryMailResult> {
    return this.mail.handle(job);
  }
}

/**
 * The job name of the automatic reminder.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const CHECKOUT_RECOVERY_SWEEP_JOB = 'checkout_recovery_sweep';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface CheckoutRecoverySweepData {
  readonly runId?: number;
}

const NOTHING: SweepSummary = { due: 0, queued: 0, skipped: 0 };

/**
 * Runs the automatic reminder when the schedule ticks.
 *
 * Why: RULES checkouts 3. A tick with nothing due writes no `job_runs` row (a run every few minutes with nothing to do would bury the
 * jobs list, like the automatic credit); a tick that finds checkouts, and every manual run, is recorded with its counts.
 */
@Injectable()
@QueueProcessor('maintenance', CHECKOUT_RECOVERY_SWEEP_JOB)
export class CheckoutRecoverySweepProcessor implements JobProcessor<CheckoutRecoverySweepData, SweepSummary> {
  constructor(
    private readonly sweep: RecoverySweep,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the tick did
   */
  async process(job: Job<CheckoutRecoverySweepData, SweepSummary, string>): Promise<SweepSummary> {
    const runId = job.data.runId;
    const due = await this.sweep.due();
    if (due.length === 0 && runId === undefined) return NOTHING;
    let summary = NOTHING;
    const options =
      runId === undefined
        ? ({ job: CHECKOUT_RECOVERY_SWEEP_JOB, trigger: 'schedule' } as const)
        : ({ job: CHECKOUT_RECOVERY_SWEEP_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      summary = await this.sweep.run(due);
      return { processed: summary.queued, result: { ...summary } };
    });
    return summary;
  }
}
