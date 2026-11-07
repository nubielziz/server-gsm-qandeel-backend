// The worker job that credits confirmed top-ups of automatic gateways (money module, queue maintenance, job payment_auto_credit).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { type AutoCreditSummary, PaymentAutoCredit } from './payment-auto-credit';

/**
 * The job name of the automatic credit.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const PAYMENT_AUTO_CREDIT_JOB = 'payment_auto_credit';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface PaymentAutoCreditData {
  readonly runId?: number;
}

const NOTHING: AutoCreditSummary = { checked: 0, credited: 0, review: 0, deferred: 0, skipped: 0, failed: 0 };

/**
 * Runs the automatic credit when the minute tick arrives.
 *
 * Why: user rule 6. A tick with nothing due writes no `job_runs` row (like the outbox tick: a job every minute would bury the jobs
 * list in empty runs); a tick that handles payments, and every manual run, is recorded with its counts (decision 020).
 */
@Injectable()
@QueueProcessor('maintenance', PAYMENT_AUTO_CREDIT_JOB)
export class PaymentAutoCreditProcessor implements JobProcessor<PaymentAutoCreditData, AutoCreditSummary> {
  constructor(
    private readonly credit: PaymentAutoCredit,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what happened to the due payments
   */
  async process(job: Job<PaymentAutoCreditData, AutoCreditSummary, string>): Promise<AutoCreditSummary> {
    const runId = job.data.runId;
    const due = await this.credit.due();
    if (due.length === 0 && runId === undefined) return NOTHING;
    let summary = NOTHING;
    const options =
      runId === undefined
        ? ({ job: PAYMENT_AUTO_CREDIT_JOB, trigger: 'schedule' } as const)
        : ({ job: PAYMENT_AUTO_CREDIT_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      summary = await this.credit.run(due);
      return { processed: summary.credited, result: { ...summary } };
    });
    return summary;
  }
}
