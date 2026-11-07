// The worker jobs of the health module (queue `maintenance`): the minute checker, the daily purge of old checks and runs, the
// reaper of runs left `running`, and the daily database size sample. Each wraps its work in `job_runs` (decision 020) and, for a
// manual run (`data.runId`, started by `POST /admin/system/jobs/:name/run`), records on the row the route inserted.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { ComponentChecker } from '../application/component-checker';
import { purgeRuns } from '../infra/job-runs-admin.repository';
import { purgeChecks } from '../infra/service-checks.repository';
import { JobRunsService } from '../job-runs/job-runs.service';

/** The job names (they are the names the console's jobs list shows). */
export const SERVICE_CHECKS_JOB = 'service_checks';
/** See {@link SERVICE_CHECKS_JOB}. */
export const SERVICE_CHECKS_PURGE_JOB = 'service_checks_purge';
/** See {@link SERVICE_CHECKS_JOB}. */
export const JOB_RUNS_REAPER_JOB = 'job_runs_reaper';
/** See {@link SERVICE_CHECKS_JOB}. */
export const DB_SIZE_SAMPLE_JOB = 'db_size_sample';

/** How long `service_checks` and finished `job_runs` are kept. */
export const RETENTION_DAYS = 90;
/** A run left `running` longer than this is closed as failed (its worker died). */
export const STUCK_RUN_MS = 2 * 60 * 60_000;

/** The data of a health job: empty for a schedule; a manual run carries its `job_runs` id. */
export interface HealthJobData {
  readonly runId?: number;
}

/** The options `JobRunsService.run` takes for a job's schedule or manual run. */
function optionsOf(job: string, data: HealthJobData) {
  return data.runId === undefined
    ? ({ job, trigger: 'schedule' } as const)
    : ({ job, trigger: 'manual', runId: data.runId } as const);
}

/** Runs the component checks every minute. */
@Injectable()
@QueueProcessor('maintenance', SERVICE_CHECKS_JOB)
export class ServiceChecksProcessor implements JobProcessor<HealthJobData, void> {
  constructor(
    private readonly checker: ComponentChecker,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the counts are in the run's `result`
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    await this.runs.run(optionsOf(SERVICE_CHECKS_JOB, job.data), async () => {
      const report = await this.checker.runOnce();
      return { processed: report.checked, result: { ...report } };
    });
  }
}

/** Deletes `service_checks` and finished `job_runs` older than 90 days. */
@Injectable()
@QueueProcessor('maintenance', SERVICE_CHECKS_PURGE_JOB)
export class ServiceChecksPurgeProcessor implements JobProcessor<HealthJobData, void> {
  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the counts are in the run's `result`
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    await this.runs.run(optionsOf(SERVICE_CHECKS_PURGE_JOB, job.data), async () => {
      const before = new Date(this.clock.now().getTime() - RETENTION_DAYS * 86_400_000);
      const checks = await purgeChecks(this.db.db, before);
      const runs = await purgeRuns(this.db.db, before);
      return { processed: checks + runs, result: { checks, runs } };
    });
  }
}

/** Closes runs that a dead worker left in `running`, so the one-run-at-a-time guard cannot lock a job for ever. */
@Injectable()
@QueueProcessor('maintenance', JOB_RUNS_REAPER_JOB)
export class JobRunsReaperProcessor implements JobProcessor<HealthJobData, void> {
  constructor(private readonly runs: JobRunsService) {}

  /**
   * Handles one tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the count is in the run's `result`
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    await this.runs.run(optionsOf(JOB_RUNS_REAPER_JOB, job.data), async () => {
      const closed = await this.runs.failStuck(STUCK_RUN_MS);
      return { processed: closed, result: { closed } };
    });
  }
}

/** Samples the database size once a day, for the growth per day of `GET /admin/system/database`. */
@Injectable()
@QueueProcessor('maintenance', DB_SIZE_SAMPLE_JOB)
export class DbSizeSampleProcessor implements JobProcessor<HealthJobData, void> {
  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick or manual run.
   *
   * @param job the BullMQ job
   * @returns nothing; the size is in the run's `result`
   */
  async process(job: Job<HealthJobData, void, string>): Promise<void> {
    await this.runs.run(optionsOf(DB_SIZE_SAMPLE_JOB, job.data), async () => {
      const result = await this.db.db.execute<{ bytes: string }>(
        sql`select pg_database_size(current_database())::text as bytes`,
      );
      const bytes = Number(result.rows[0]?.bytes ?? 0);
      return { processed: 1, result: { bytes } };
    });
  }
}
