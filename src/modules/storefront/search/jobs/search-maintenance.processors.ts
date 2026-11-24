// The processors of the storefront search on the `maintenance` queue (feature 29, plan section 4.5): reconcile, rebuild, terms build,
// terms flush and purge. Each run is recorded in `job_runs`; none writes documents through the services alias. Worker only.
import { Injectable } from '@nestjs/common';
import { type Job, type JobProcessor, QueueProcessor } from '../../../../infra/queues';
import { JobRunsService, type RunJobOptions } from '../../../health';
import type { OutboxJobData } from '../../../platform';
import { type RebuildReport, SearchRebuild } from '../application/search-rebuild';
import { type ReconcileReport, SearchReconcile } from '../application/search-reconcile';
import { SEARCH_JOBS } from '../application/search-signals';
import { SearchTermsBuild, type TermsBuildReport } from '../application/search-terms-build';
import { SearchTermsFlush, type TermsFlushReport } from '../application/search-terms-flush';

/**
 * The data of a maintenance job of the search: nothing (a schedule), `{ runId }` (a manual run from the console's jobs page),
 * `{ reason }` (a follow-up: `boot`, `not_ready`, `after_rebuild`) or, for the rebuild, the outbox event
 * `search.rebuild_requested { staffId, runId? }`.
 */
export type MaintenanceJobData = { readonly runId?: number; readonly reason?: string } | OutboxJobData;

/**
 * How a job's run is recorded in `job_runs`.
 *
 * @param job the job name
 * @param data the job data
 * @returns the run options: `manual` (with the staff member and the route's run, when given), `event` for a follow-up, else `schedule`
 */
export function runOptionsOf(job: string, data: MaintenanceJobData): RunJobOptions {
  if ('payload' in data) {
    const { staffId, runId } = data.payload;
    return {
      job,
      trigger: 'manual',
      ...(typeof staffId === 'number' ? { triggeredBy: staffId } : {}),
      ...(typeof runId === 'number' ? { runId } : {}),
    };
  }
  if (typeof data.runId === 'number') return { job, trigger: 'manual', runId: data.runId };
  if (typeof data.reason === 'string') return { job, trigger: 'event' };
  return { job, trigger: 'schedule' };
}

/**
 * Runs `search_reconcile`.
 *
 * Why: plan section 4.5: anything missed reaches the index within one reconcile period; a missing alias starts a rebuild.
 */
@Injectable()
@QueueProcessor('maintenance', SEARCH_JOBS.reconcile)
export class SearchReconcileProcessor implements JobProcessor<MaintenanceJobData, ReconcileReport | null> {
  constructor(
    private readonly reconcile: SearchReconcile,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one reconcile job.
   *
   * @param job the BullMQ job
   * @returns the report, or `null` when another run of the job was going on
   */
  async process(job: Job<MaintenanceJobData, ReconcileReport | null, string>): Promise<ReconcileReport | null> {
    let report: ReconcileReport | null = null;
    await this.runs.run(runOptionsOf(SEARCH_JOBS.reconcile, job.data), async (run) => {
      report = await this.reconcile.run(run.id);
      return {
        processed: report.jobs,
        result: { ...report },
        skipped: report.outcome === 'skipped' || report.outcome === 'disabled',
      };
    });
    return report;
  }
}

/**
 * Runs `search_rebuild`.
 *
 * Why: plan section 4.5: the nightly rebuild, the console's "Rebuild index" and the reconcile's not-ready answer make the index whole.
 */
@Injectable()
@QueueProcessor('maintenance', SEARCH_JOBS.rebuild)
export class SearchRebuildProcessor implements JobProcessor<MaintenanceJobData, RebuildReport | null> {
  constructor(
    private readonly rebuild: SearchRebuild,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one rebuild job.
   *
   * @param job the BullMQ job
   * @returns the report, or `null` when another run of the job was going on
   */
  async process(job: Job<MaintenanceJobData, RebuildReport | null, string>): Promise<RebuildReport | null> {
    let report: RebuildReport | null = null;
    await this.runs.run(runOptionsOf(SEARCH_JOBS.rebuild, job.data), async (run) => {
      report = await this.rebuild.run(run.id);
      return {
        processed: report.documents,
        result: { ...report },
        skipped: report.outcome === 'skipped' || report.outcome === 'disabled',
      };
    });
    return report;
  }
}

/**
 * Runs `search_terms_build`.
 *
 * Why: plan section 4.4: the completions follow the catalog, the synonyms and the popular queries hourly.
 */
@Injectable()
@QueueProcessor('maintenance', SEARCH_JOBS.termsBuild)
export class SearchTermsBuildProcessor implements JobProcessor<MaintenanceJobData, TermsBuildReport | null> {
  constructor(
    private readonly terms: SearchTermsBuild,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one terms build job.
   *
   * @param job the BullMQ job
   * @returns the report, or `null` when another run of the job was going on
   */
  async process(job: Job<MaintenanceJobData, TermsBuildReport | null, string>): Promise<TermsBuildReport | null> {
    let report: TermsBuildReport | null = null;
    await this.runs.run(runOptionsOf(SEARCH_JOBS.termsBuild, job.data), async () => {
      report = await this.terms.run();
      return {
        processed: report.terms,
        result: { ...report },
        skipped: report.outcome === 'skipped' || report.outcome === 'disabled',
      };
    });
    return report;
  }
}

/**
 * Runs `search_terms_flush`.
 *
 * Why: plan section 5.6: the day's counters reach Postgres every 15 minutes.
 */
@Injectable()
@QueueProcessor('maintenance', SEARCH_JOBS.termsFlush)
export class SearchTermsFlushProcessor implements JobProcessor<MaintenanceJobData, TermsFlushReport | null> {
  constructor(
    private readonly flush: SearchTermsFlush,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one flush job.
   *
   * @param job the BullMQ job
   * @returns the report, or `null` when another run of the job was going on
   */
  async process(job: Job<MaintenanceJobData, TermsFlushReport | null, string>): Promise<TermsFlushReport | null> {
    let report: TermsFlushReport | null = null;
    await this.runs.run(runOptionsOf(SEARCH_JOBS.termsFlush, job.data), async () => {
      report = await this.flush.flush();
      return { processed: report.terms, result: { ...report } };
    });
    return report;
  }
}

/**
 * Runs `search_terms_purge`.
 *
 * Why: plan section 5.6 and owner question 8: the daily figures are kept 180 days.
 */
@Injectable()
@QueueProcessor('maintenance', SEARCH_JOBS.termsPurge)
export class SearchTermsPurgeProcessor implements JobProcessor<MaintenanceJobData, number> {
  constructor(
    private readonly flush: SearchTermsFlush,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one purge job.
   *
   * @param job the BullMQ job
   * @returns how many rows were deleted
   */
  async process(job: Job<MaintenanceJobData, number, string>): Promise<number> {
    let deleted = 0;
    await this.runs.run(runOptionsOf(SEARCH_JOBS.termsPurge, job.data), async () => {
      deleted = await this.flush.purge();
      return { processed: deleted, result: { deleted } };
    });
    return deleted;
  }
}
