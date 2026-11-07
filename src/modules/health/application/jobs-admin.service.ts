// The scheduled jobs list and the manual run (`GET /admin/system/jobs`, `POST /admin/system/jobs/:name/run`): the BullMQ job
// schedulers on the queue Redis joined with `job_runs` (decision 020, resolutions health-commissions-16).
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { QUEUE_NAMES, type QueueName, QueuesService } from '../../../infra/queues';
import { AuditService } from '../../platform';
import { cronOf, cronText, jobLabel } from '../domain/cron-text';
import { jobState } from '../domain/queue-verdict';
import { isRecordedJob } from '../domain/unrecorded-jobs';
import { orUnavailable } from './database-guard';
import {
  type JobRunRow,
  findRunRow,
  lastFinishedRuns,
  runningJobNames,
  runsOfJob,
} from '../infra/job-runs-admin.repository';
import { JobRunsService } from '../job-runs/job-runs.service';

/** How many runs of one job the history lists. */
const HISTORY_LIMIT = 50;

/** One run on the wire (the console's `JobRun`). */
export interface JobRunView {
  id: number;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  processed: number;
  trigger: 'schedule' | 'manual' | 'event';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  error: string | null;
  result: Record<string, never> | null;
  triggeredBy: { id: number; name: string } | null;
}

/** A scheduler found on a queue. */
interface Scheduler {
  readonly queue: QueueName;
  readonly name: string;
  readonly cron: string;
  readonly next: Date | null;
}

/**
 * Maps a run to the wire.
 *
 * @param row the run and its staff member
 * @returns the console's `JobRun`
 */
export function toJobRun(row: JobRunRow): JobRunView {
  const { run } = row;
  return {
    id: run.id,
    job: run.job,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
    processed: run.processed,
    trigger: run.trigger,
    status: run.status,
    error: run.error ?? null,
    result: (run.result ?? null) as JobRunView['result'],
    triggeredBy: row.triggeredBy,
  };
}

/**
 * Lists scheduled jobs and starts a manual run.
 *
 * Why: the Jobs tab shows each scheduled job's last result and next run and lets staff run one now (for example the price sync). The
 * schedules are the BullMQ job schedulers the worker created at boot, so the list is what really runs, whichever process serves the
 * request. A manual run is a `job_runs` row (`trigger manual`, `running`, the staff member) plus a job on the job's own queue with id
 * `manual-<run id>` (BullMQ refuses `:`); the processor records its work on that row.
 *
 * Only the jobs that write `job_runs` are listed or run: the housekeeping jobs of `UNRECORDED_JOBS` (the outbox tick, the IP rule hit flush
 * and the supplier poll tick) ignore `data.runId`, so a manual run would leave a `running` row nobody closes. They are 404 here.
 *
 * Side effects: `run` inserts a `job_runs` row, adds a BullMQ job and writes an audit row.
 */
@Injectable()
export class JobsAdminService {
  constructor(
    private readonly queues: QueuesService,
    private readonly db: DbService,
    private readonly runs: JobRunsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists the scheduled jobs and, for one job, its runs.
   *
   * @param job the job whose history to include, or `undefined`
   * @returns the jobs and the history
   * @throws {AppError} `NOT_FOUND` for an unknown job; `UNAVAILABLE` when the queue Redis does not answer; `DATABASE_UNAVAILABLE` when Postgres is down
   */
  async list(job: string | undefined): Promise<{ jobs: unknown[]; runs: JobRunView[] }> {
    const schedulers = await this.schedulers();
    if (job !== undefined && !schedulers.some((scheduler) => scheduler.name === job)) {
      throw new AppError('NOT_FOUND', { detail: `There is no scheduled job "${job}".` });
    }
    const names = [...new Set(schedulers.map((scheduler) => scheduler.name))];
    const [last, running, history] = await orUnavailable(() =>
      Promise.all([
        lastFinishedRuns(this.db.db, names),
        runningJobNames(this.db.db),
        job === undefined ? Promise.resolve([]) : runsOfJob(this.db.db, job, HISTORY_LIMIT),
      ]),
    );
    const seen = new Set<string>();
    const jobs = schedulers
      .filter((scheduler) => !seen.has(scheduler.name) && seen.add(scheduler.name))
      .map((scheduler) => {
        const lastRun = last.get(scheduler.name);
        return {
          name: scheduler.name,
          label: jobLabel(scheduler.name),
          schedule: scheduler.cron,
          scheduleText: cronText(scheduler.cron),
          state: jobState(lastRun?.run.status ?? null),
          running: running.has(scheduler.name),
          lastRun: lastRun ? toJobRun(lastRun) : null,
          nextRunAt: scheduler.next?.toISOString() ?? null,
        };
      });
    return { jobs, runs: history.map(toJobRun) };
  }

  /**
   * Starts a manual run of a scheduled job.
   *
   * @param name the job name
   * @param staffId the staff member who asked
   * @returns the new run (`running`, `manual`)
   * @throws {AppError} `NOT_FOUND` for an unknown job; `JOB_ALREADY_RUNNING` (409) while a run is going; `UNAVAILABLE` when it cannot be queued
   */
  async run(name: string, staffId: number): Promise<JobRunView> {
    const scheduler = (await this.schedulers()).find((candidate) => candidate.name === name);
    if (!scheduler) throw new AppError('NOT_FOUND', { detail: `There is no scheduled job "${name}".` });
    const run = await this.runs.start({ job: name, trigger: 'manual', triggeredBy: staffId, overlap: 'refuse' });
    try {
      await this.queues.add(scheduler.queue, name, { runId: run.id }, { jobId: `manual-${run.id}` });
    } catch (error) {
      await this.runs.finish(run.id, { status: 'failed', error: 'The job could not be queued.' });
      throw error;
    }
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, { action: 'ran job', entityType: 'job', entityLabel: name, after: { runId: run.id } }),
    );
    const row = await findRunRow(this.db.db, run.id);
    return toJobRun(row ?? { run, triggeredBy: null });
  }

  /** Every job scheduler of every queue whose job writes `job_runs` (the schedules the worker upserted at boot). */
  private async schedulers(): Promise<Scheduler[]> {
    try {
      const perQueue = await Promise.all(
        QUEUE_NAMES.map(async (queue) =>
          (await this.queues.queue(queue).getJobSchedulers(0, -1, true)).map((scheduler) => ({
            queue,
            name: scheduler.name,
            cron: cronOf({ pattern: scheduler.pattern ?? null, every: scheduler.every ?? null }),
            next: scheduler.next === undefined || scheduler.next === null ? null : new Date(scheduler.next),
          })),
        ),
      );
      return perQueue.flat().filter((scheduler) => isRecordedJob(scheduler.name));
    } catch (error) {
      throw new AppError('UNAVAILABLE', {
        detail: 'The queue Redis is not answering right now.',
        cause: error,
        retryAfterSeconds: 5,
      });
    }
  }
}
