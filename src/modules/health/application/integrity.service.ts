// The integrity use cases (map routes /admin/system/integrity*, feature 12b): the report of the last run and the manual run. The checks themselves run
// in the worker (`LedgerIntegrityCheck`); the API never does slow work inline (decision 020).
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { QueuesService } from '../../../infra/queues';
import { AuditService } from '../../platform';
import { INTEGRITY_JOB, type CheckResult, checksFromResult, countsAsLastRun, overallResult } from '../domain/integrity';
import { lastCleanIntegrityFinish, lastFinishedIntegrityRun } from '../infra/integrity-runs.repository';
import { findRunRow } from '../infra/job-runs-admin.repository';
import { JobRunsService } from '../job-runs/job-runs.service';
import { orUnavailable } from './database-guard';
import { type JobRunView, toJobRun } from './jobs-admin.service';

/** The report of `GET /admin/system/integrity`. */
export interface IntegrityReportView {
  running: boolean;
  runningSince: string | null;
  lastRun: JobRunView | null;
  lastSuccessAt: string | null;
  result: 'pass' | 'fail' | 'unknown';
  checks: CheckResult[];
}

/**
 * Reports on the ledger integrity check and starts it on demand.
 *
 * Why: scenario system-integrity steps 3 and 7: a staff member opens the details (the account, the difference, the last entry, the time of the last
 * successful check) and reruns the check now as a background job. The report is built from `job_runs` of the job `ledger_integrity` (B99: the
 * counters are top-level in the run's `result`, the four checks nested under `checks`). The check only reads the ledger and never corrects anything.
 *
 * Side effects: `run` inserts a `job_runs` row, adds a BullMQ job on the `maintenance` queue (id `manual-<run id>`) and writes one audit row.
 */
@Injectable()
export class IntegrityService {
  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    private readonly queues: QueuesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The integrity report.
   *
   * @returns whether a run is going, the last finished run, the time of the last clean one and the four checks of the last finished run
   *   (all `unknown` before the first run, or when the last run failed)
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres cannot be reached
   */
  async report(): Promise<IntegrityReportView> {
    const [running, last, cleanAt] = await orUnavailable(() =>
      Promise.all([
        this.runs.findRunning(INTEGRITY_JOB),
        lastFinishedIntegrityRun(this.db.db),
        lastCleanIntegrityFinish(this.db.db),
      ]),
    );
    const finished = last && countsAsLastRun(last.run.status) ? last : undefined;
    // A run that failed has no checks: the page must show them unknown, never pass.
    const checks =
      finished && finished.run.status === 'succeeded' ? checksFromResult(finished.run.result) : checksFromResult(null);
    return {
      running: running !== undefined,
      runningSince: running?.startedAt.toISOString() ?? null,
      lastRun: finished ? toJobRun(finished) : null,
      lastSuccessAt: cleanAt?.toISOString() ?? null,
      result: overallResult(checks),
      checks,
    };
  }

  /**
   * Starts the integrity check now.
   *
   * @param staffId the staff member who asked
   * @returns the new run (`running`, `manual`)
   * @throws {AppError} `JOB_ALREADY_RUNNING` (409) while a nightly or manual run is going; `UNAVAILABLE` when the job cannot be queued;
   *   `DATABASE_UNAVAILABLE` when Postgres cannot be reached
   */
  async run(staffId: number): Promise<JobRunView> {
    const run = await orUnavailable(() =>
      this.runs.start({ job: INTEGRITY_JOB, trigger: 'manual', triggeredBy: staffId, overlap: 'refuse' }),
    );
    try {
      await this.queues.add('maintenance', INTEGRITY_JOB, { runId: run.id }, { jobId: `manual-${run.id}` });
    } catch (error) {
      // No job will ever close this row: close it now so it cannot block the next run.
      await this.runs.finish(run.id, { status: 'failed', error: 'The job could not be queued.' });
      throw error;
    }
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: 'ran job',
        entityType: 'job',
        entityLabel: INTEGRITY_JOB,
        after: { runId: run.id },
      }),
    );
    const row = await findRunRow(this.db.db, run.id);
    return toJobRun(row ?? { run, triggeredBy: null });
  }
}
