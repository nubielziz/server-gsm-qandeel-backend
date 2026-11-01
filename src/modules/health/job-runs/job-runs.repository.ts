// Drizzle queries on job_runs, the run log of scheduled and manual jobs (health module, decision 020).
import { and, eq, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type JobRun, type JobStatus, type JobTrigger, jobRuns } from '../db/schema';

/**
 * `(now - started_at)` in whole milliseconds, where `now` is the injected clock's time that also stamped `started_at`
 * (decision 031).
 * Never below zero: `job_runs_counts_check` refuses a negative duration, and a wall clock that stepped back (NTP, a VM
 * resume) must not stop a run from being closed.
 */
const elapsedMs = (now: Date) =>
  sql<number>`greatest(0, (extract(epoch from (${now}::timestamptz - ${jobRuns.startedAt})) * 1000)::int)`;

/** How a run ended. */
export interface JobRunOutcome {
  readonly status: Exclude<JobStatus, 'running'>;
  readonly processed?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

/**
 * Takes the transaction-scoped advisory lock of one job name, so two starters of the same job queue up.
 *
 * Why: "one run per job at a time" is checked and then inserted; without the lock two workers could both see no running
 * run and both insert one. The lock is released when the transaction ends.
 *
 * @param tx the transaction that will check and insert
 * @param job the job name
 */
export async function lockJobRuns(tx: DbExecutor, job: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`job_runs:${job}`}, 0))`);
}

/**
 * Finds a run by id.
 *
 * @param db the database or a transaction
 * @param id the run id
 * @returns the run, or `undefined`
 */
export async function findJobRun(db: DbExecutor, id: number): Promise<JobRun | undefined> {
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, id)).limit(1);
  return row;
}

/**
 * Finds the run of a job that is going on right now, if any (the newest when a stale one is left behind).
 *
 * @param db the database or a transaction
 * @param job the job name
 * @returns the running run, or `undefined`
 */
export async function findRunningJobRun(db: DbExecutor, job: string): Promise<JobRun | undefined> {
  const [row] = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), eq(jobRuns.status, 'running')))
    .orderBy(sql`${jobRuns.id} desc`)
    .limit(1);
  return row;
}

/**
 * Inserts a run that has started.
 *
 * @param db the database or a transaction
 * @param values job, trigger and the staff member for a manual run
 * @param now the start time, from the injected clock (decision 031)
 * @returns the new `running` run
 */
export async function insertRunningJobRun(
  db: DbExecutor,
  values: { job: string; trigger: JobTrigger; triggeredBy: number | undefined },
  now: Date,
): Promise<JobRun> {
  const [row] = await db
    .insert(jobRuns)
    .values({
      job: values.job,
      trigger: values.trigger,
      status: 'running',
      triggeredBy: values.triggeredBy ?? null,
      startedAt: now,
    })
    .returning();
  if (!row) throw new Error('Inserting a job run returned no row.');
  return row;
}

/**
 * Inserts a run that did nothing because another run of the same job was going on.
 *
 * @param db the database or a transaction
 * @param values job, trigger and the staff member for a manual run
 * @param runningId the id of the run that was in the way
 * @param now the start and end time, from the injected clock (decision 031)
 * @returns the new `skipped` run, already finished
 */
export async function insertSkippedJobRun(
  db: DbExecutor,
  values: { job: string; trigger: JobTrigger; triggeredBy: number | undefined },
  runningId: number,
  now: Date,
): Promise<JobRun> {
  const [row] = await db
    .insert(jobRuns)
    .values({
      job: values.job,
      trigger: values.trigger,
      status: 'skipped',
      triggeredBy: values.triggeredBy ?? null,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      processed: 0,
      result: { reason: 'another run of this job was still going on', runningRunId: runningId },
    })
    .returning();
  if (!row) throw new Error('Inserting a skipped job run returned no row.');
  return row;
}

/**
 * Closes a run that is still `running`.
 *
 * Why: the update is guarded by `status = 'running'`, so a run that was already closed (by the reaper, or by an earlier
 * attempt of the same job) is never overwritten.
 *
 * @param db the database or a transaction
 * @param id the run id
 * @param outcome how it ended
 * @param now the end time, from the injected clock (decision 031)
 * @returns the closed run, or `undefined` when it was not running
 */
export async function finishJobRun(
  db: DbExecutor,
  id: number,
  outcome: JobRunOutcome,
  now: Date,
): Promise<JobRun | undefined> {
  const [row] = await db
    .update(jobRuns)
    .set({
      status: outcome.status,
      finishedAt: now,
      durationMs: elapsedMs(now),
      processed: outcome.processed ?? 0,
      result: outcome.result ?? {},
      error: outcome.error ?? null,
    })
    .where(and(eq(jobRuns.id, id), eq(jobRuns.status, 'running')))
    .returning();
  return row;
}

/**
 * Fails the runs that have been `running` for longer than a limit.
 *
 * @param db the database or a transaction
 * @param maxAgeMs how old a running run must be to count as stuck
 * @param now the current time, from the injected clock (decision 031)
 * @returns the ids of the runs that were closed
 */
export async function failStuckJobRuns(db: DbExecutor, maxAgeMs: number, now: Date): Promise<number[]> {
  const rows = await db
    .update(jobRuns)
    .set({
      status: 'failed',
      finishedAt: now,
      durationMs: elapsedMs(now),
      error: 'The worker stopped before this run finished.',
    })
    .where(and(eq(jobRuns.status, 'running'), lt(jobRuns.startedAt, new Date(now.getTime() - maxAgeMs))))
    .returning({ id: jobRuns.id });
  return rows.map((row) => row.id);
}
