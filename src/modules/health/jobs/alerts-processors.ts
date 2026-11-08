// The worker jobs of feature 12b: the minute alert evaluation (queue `alerts`) and the money integrity check (queue `maintenance`, nightly and manual).
// Each wraps its work in `job_runs` (decision 020); a manual run (`data.runId`, inserted by `POST /admin/system/integrity/run` or
// `POST /admin/system/jobs/:name/run`) is recorded on that row.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { AlertEvaluator } from '../application/alert-evaluator';
import { LedgerIntegrityCheck } from '../application/ledger-integrity-check';
import { INTEGRITY_JOB, integrityResult } from '../domain/integrity';
import { ALERT_EVALUATION_JOB } from '../infra/alerts-read.repository';
import { JobRunsService } from '../job-runs/job-runs.service';
import { type HealthJobData, optionsOf } from './health-processors';

/** Evaluates every active alert rule once a minute. */
@Injectable()
@QueueProcessor('alerts', ALERT_EVALUATION_JOB)
export class AlertEvaluationProcessor implements JobProcessor<HealthJobData, void> {
  constructor(
    private readonly evaluator: AlertEvaluator,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the counts are in the run's `result` (`unevaluated` above 0 tells the health page not to read "no alerts" as healthy)
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    await this.runs.run(optionsOf(ALERT_EVALUATION_JOB, job.data), async () => {
      const report = await this.evaluator.evaluateAll();
      return { processed: report.evaluated, result: { ...report } };
    });
  }
}

/** Checks the integrity of the ledger every night and on demand; reads only, never corrects. */
@Injectable()
@QueueProcessor('maintenance', INTEGRITY_JOB)
export class LedgerIntegrityProcessor implements JobProcessor<HealthJobData, void> {
  constructor(
    private readonly check: LedgerIntegrityCheck,
    private readonly evaluator: AlertEvaluator,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one nightly tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the four checks and their findings are in the run's `result` (MISMATCHES B99)
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    const run = await this.runs.run(optionsOf(INTEGRITY_JOB, job.data), async () => {
      const outcome = await this.check.run();
      return { processed: outcome.totals.accountsChecked, result: integrityResult(outcome.checks, outcome.totals) };
    });
    // The `ledger.mismatch_count` rule reads this run: judging it now opens the alert on a mismatch and closes it on a clean run (scenario
    // system-integrity steps 2 and 7) without waiting for the next evaluation tick. A retry of a finished manual run lands here again, harmlessly.
    if (run.status === 'succeeded') await this.evaluator.evaluateMetric('ledger.mismatch_count');
  }
}
