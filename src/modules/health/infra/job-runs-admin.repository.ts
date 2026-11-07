// Read queries on `job_runs` for the System health jobs routes (health module): the newest finished run of each job, the runs of
// one job, and the jobs that are running now. The staff name of a manual run is read from `staff_users` (identity) with a plain
// join: identity exports no reader of staff names, and the join is the console's `triggeredBy {id, name}`.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { type JobRun, jobRuns } from '../db/schema';

/** A run with the staff member who started it (`null` for a scheduled run). */
export interface JobRunRow {
  readonly run: JobRun;
  readonly triggeredBy: { readonly id: number; readonly name: string } | null;
}

const withStaff = (db: DbExecutor) =>
  db
    .select({ run: jobRuns, staffId: s.staffUsers.id, staffName: s.staffUsers.name })
    .from(jobRuns)
    .leftJoin(s.staffUsers, eq(s.staffUsers.id, jobRuns.triggeredBy));

const toRow = (row: { run: JobRun; staffId: number | null; staffName: string | null }): JobRunRow => ({
  run: row.run,
  triggeredBy: row.staffId === null || row.staffName === null ? null : { id: row.staffId, name: row.staffName },
});

/**
 * The newest finished run of each job.
 *
 * Why: `lastRun` of a scheduled job is the newest run that is over, never the running one (health-commissions-16).
 *
 * @param db the database
 * @param jobs the job names
 * @returns the run by job name (a job that never finished has no entry)
 */
export async function lastFinishedRuns(db: DbExecutor, jobs: readonly string[]): Promise<Map<string, JobRunRow>> {
  if (jobs.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([jobRuns.job], { run: jobRuns, staffId: s.staffUsers.id, staffName: s.staffUsers.name })
    .from(jobRuns)
    .leftJoin(s.staffUsers, eq(s.staffUsers.id, jobRuns.triggeredBy))
    .where(and(inArray(jobRuns.job, [...jobs]), sql`${jobRuns.status} <> 'running'`))
    .orderBy(jobRuns.job, desc(jobRuns.startedAt), desc(jobRuns.id));
  return new Map(rows.map((row) => [row.run.job, toRow(row)]));
}

/**
 * The names of the jobs that have a run going on.
 *
 * @param db the database
 * @returns the job names
 */
export async function runningJobNames(db: DbExecutor): Promise<Set<string>> {
  const rows = await db.selectDistinct({ job: jobRuns.job }).from(jobRuns).where(eq(jobRuns.status, 'running'));
  return new Set(rows.map((row) => row.job));
}

/**
 * The newest runs of one job, running ones included.
 *
 * @param db the database
 * @param job the job name
 * @param limit how many runs at most
 * @returns the runs, newest first
 */
export async function runsOfJob(db: DbExecutor, job: string, limit: number): Promise<JobRunRow[]> {
  const rows = await withStaff(db)
    .where(eq(jobRuns.job, job))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(limit);
  return rows.map(toRow);
}

/**
 * One run by id, with its staff member.
 *
 * @param db the database or a transaction
 * @param id the run id
 * @returns the run, or `undefined`
 */
export async function findRunRow(db: DbExecutor, id: number): Promise<JobRunRow | undefined> {
  const [row] = await withStaff(db).where(eq(jobRuns.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * The results of the succeeded runs of a job since a time, oldest first.
 *
 * Why: the cache Redis figures that are deltas (evictions per minute) and the database growth per day come from counters the
 * checker and the daily sample store in the `result` of their own runs.
 *
 * @param db the database
 * @param job the job name
 * @param since the start of the window
 * @returns start time and result of each run
 */
export async function succeededResults(
  db: DbExecutor,
  job: string,
  since: Date,
): Promise<Array<{ startedAt: Date; result: Record<string, unknown> }>> {
  const rows = await db
    .select({ startedAt: jobRuns.startedAt, result: jobRuns.result })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), eq(jobRuns.status, 'succeeded'), sql`${jobRuns.startedAt} >= ${since}`))
    .orderBy(jobRuns.startedAt);
  return rows.map((row) => ({ startedAt: row.startedAt, result: row.result ?? {} }));
}

/**
 * Deletes finished runs older than a cut-off.
 *
 * @param db the database
 * @param before runs that started before this go
 * @returns how many rows were deleted
 */
export async function purgeRuns(db: DbExecutor, before: Date): Promise<number> {
  const rows = await db
    .delete(jobRuns)
    .where(and(sql`${jobRuns.startedAt} < ${before}`, sql`${jobRuns.status} <> 'running'`))
    .returning({ id: jobRuns.id });
  return rows.length;
}
