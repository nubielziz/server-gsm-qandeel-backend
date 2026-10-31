// JobRunsService: the run log of scheduled and manual jobs (job_runs, health module). Processors wrap their work with
// run(); the manual-run route of the health feature starts a run with start() and hands its id to the job.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { JobRun, JobTrigger } from '../db/schema';
import {
  type JobRunOutcome,
  failStuckJobRuns,
  findJobRun,
  findRunningJobRun,
  finishJobRun,
  insertRunningJobRun,
  insertSkippedJobRun,
  lockJobRuns,
} from './job-runs.repository';
import { UnrecoverableError } from '../../../infra/queues';

/**
 * What to do when another run of the same job is going on.
 *
 * Why: a scheduled job that takes longer than its interval must not pile up (`skip` records a `skipped` run and does
 * nothing); a manual run asked for by staff must be refused with 409 (`refuse`); `allow` does not look.
 */
export type RunOverlap = 'allow' | 'skip' | 'refuse';

/** What starts a run. */
export interface StartJobRunInput {
  /** The stable job name shown in the console (`ledger_integrity`, `price_sync`). */
  readonly job: string;
  readonly trigger: JobTrigger;
  /** The staff member who started a manual run. */
  readonly triggeredBy?: number;
  /** Default `allow` for {@link JobRunsService.start}, `skip` for {@link JobRunsService.run}. */
  readonly overlap?: RunOverlap;
}

/** Options of {@link JobRunsService.run}. */
export interface RunJobOptions extends StartJobRunInput {
  /**
   * The id of a run that already exists in state `running` (the manual-run route inserts it before it enqueues the job):
   * the work is recorded on that row instead of a new one.
   */
  readonly runId?: number;
}

/**
 * What a job reports when it finishes.
 *
 * Why: the console prints `processed` and the `result` counters on one line per run (GET /admin/system/jobs); the
 * integrity check keeps its findings in `result` (MISMATCHES B99).
 */
export interface JobRunReport {
  /** How many items the run handled (orders, rows, suppliers). */
  readonly processed?: number;
  /** A small object of counters: no secrets, no personal data. */
  readonly result?: Record<string, unknown>;
  /** True when the run found nothing to do on purpose; it is recorded as `skipped`. */
  readonly skipped?: boolean;
}

const MAX_ERROR_LENGTH = 1_000;

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...` : text;
}

/**
 * Writes `job_runs` around the work of a job.
 *
 * Why: decision 020 says every scheduled or manual run is recorded (start, end, duration, items, result, error); the
 * System health jobs list and the integrity report read these rows. The log must never change what a job does: a run
 * whose bookkeeping fails still did its work, and a job that throws is recorded as failed and the error goes on to
 * BullMQ, which retries it according to the queue's policy (each attempt is its own run).
 *
 * Side effects: inserts and updates `job_runs`. `run` never leaves a row `running` behind unless the process dies in
 * the middle; {@link JobRunsService.failStuck} closes those.
 *
 * @see docs/decisions/020-outbox-and-queues.md
 */
@Injectable()
export class JobRunsService {
  private readonly logger = new Logger(JobRunsService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Starts a run.
   *
   * @param input job, trigger, staff member and the overlap rule
   * @returns the new run: `running`, or `skipped` (already finished) when `overlap` is `skip` and the job is going on
   * @throws {AppError} `JOB_ALREADY_RUNNING` when `overlap` is `refuse` and another run of the job is going on
   */
  async start(input: StartJobRunInput): Promise<JobRun> {
    const overlap = input.overlap ?? 'allow';
    const values = { job: input.job, trigger: input.trigger, triggeredBy: input.triggeredBy };
    if (overlap === 'allow') return insertRunningJobRun(this.db.db, values);
    return this.db.runInTransaction(async ({ tx }) => {
      // The lock makes "is one running?" and the insert one step, so two workers cannot both start the job.
      await lockJobRuns(tx, input.job);
      const running = await findRunningJobRun(tx, input.job);
      if (!running) return insertRunningJobRun(tx, values);
      if (overlap === 'refuse') {
        throw new AppError('JOB_ALREADY_RUNNING', { detail: `The job "${input.job}" is already running.` });
      }
      return insertSkippedJobRun(tx, values, running.id);
    });
  }

  /**
   * Closes a run.
   *
   * @param id the run id
   * @param outcome how it ended
   * @returns the closed run, or `undefined` when it was not `running` any more (already closed by the reaper)
   */
  finish(id: number, outcome: JobRunOutcome): Promise<JobRun | undefined> {
    return finishJobRun(this.db.db, id, outcome);
  }

  /**
   * Finds the run of a job that is going on.
   *
   * @param job the job name
   * @returns the running run, or `undefined`
   */
  findRunning(job: string): Promise<JobRun | undefined> {
    return findRunningJobRun(this.db.db, job);
  }

  /**
   * Runs the work of a job and records it.
   *
   * Why: this is the wrapper processors use: `return this.jobRuns.run({ job: 'ledger_integrity', trigger: 'schedule' },
   * async () => ({ processed, result }))`. A manual run passes the `runId` that the route inserted.
   *
   * @param options job, trigger and, for a manual run, the existing `runId` and the staff member
   * @param work the job's work; its return value is the report, a thrown error fails the run
   * @returns the finished run (`succeeded`, `skipped`, or the `skipped` run of an overlap)
   * @throws whatever `work` threw, after the run was recorded as failed
   */
  async run(options: RunJobOptions, work: (run: JobRun) => Promise<JobRunReport | void>): Promise<JobRun> {
    let run: JobRun;
    if (options.runId !== undefined) {
      const existing = await findJobRun(this.db.db, options.runId);
      if (!existing) throw new Error(`Job run ${options.runId} does not exist.`);
      if (existing.status !== 'running') {
        // A BullMQ retry of a manual run that already failed must fail too (not end "completed"); a run that already
        // succeeded or was skipped is returned as it is, so a duplicate delivery stays harmless.
        if (existing.status === 'failed') {
          throw new UnrecoverableError(
            `Job run ${existing.id} of "${existing.job}" already failed; it is not run again.`,
          );
        }
        this.logger.warn(
          `Job run ${existing.id} of "${existing.job}" is already ${existing.status}; the work is not run again.`,
        );
        return existing;
      }
      run = existing;
    } else {
      run = await this.start({ ...options, overlap: options.overlap ?? 'skip' });
      if (run.status === 'skipped') return run;
    }

    let report: JobRunReport | void;
    try {
      report = await work(run);
    } catch (error) {
      await this.closeQuietly(run, { status: 'failed', error: describe(error) });
      throw error;
    }
    const outcome: JobRunOutcome = {
      status: report?.skipped ? 'skipped' : 'succeeded',
      processed: report?.processed ?? 0,
      result: report?.result ?? {},
    };
    return (await this.closeQuietly(run, outcome)) ?? run;
  }

  /**
   * Fails the runs that have been `running` for too long.
   *
   * Why: a worker that dies in the middle of a run (kill, crash, power) leaves its row `running`, and the "one run at a
   * time" guard would refuse every later run of the job. The health feature calls this from a maintenance schedule.
   *
   * @param maxAgeMs how old a running run must be to count as stuck
   * @returns how many runs were closed
   */
  async failStuck(maxAgeMs: number): Promise<number> {
    const ids = await failStuckJobRuns(this.db.db, maxAgeMs);
    if (ids.length > 0)
      this.logger.warn(`Closed ${ids.length} job runs that were stuck in "running": ${ids.join(', ')}`);
    return ids.length;
  }

  /** Records the end of a run without letting a bookkeeping failure hide the job's own outcome. */
  private async closeQuietly(run: JobRun, outcome: JobRunOutcome): Promise<JobRun | undefined> {
    try {
      return await this.finish(run.id, outcome);
    } catch (error) {
      this.logger.error(`Could not record the end of job run ${run.id} ("${run.job}"): ${describe(error)}`);
      return undefined;
    }
  }
}
