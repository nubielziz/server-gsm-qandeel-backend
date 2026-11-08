// Read queries on `job_runs` for the money integrity report (health module, feature 12b): the newest run that is over, the newest clean one and the
// run that is going now. The staff name of a manual run is read from `staff_users` (identity) with a plain join, like the jobs routes.
import { and, desc, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { jobRuns } from '../db/schema';
import { INTEGRITY_JOB, type Finding, checksFromResult } from '../domain/integrity';
import type { JobRunRow } from './job-runs-admin.repository';

/**
 * The newest integrity run that is over and checked something: succeeded or failed, never running and never skipped.
 *
 * Why: the report's `lastRun` (health-commissions-16, ANSWERS Q35). A skipped run did nothing, so it does not hide the result of the run it made way for.
 *
 * @param db the database
 * @returns the run with its staff member, or `undefined` when none finished yet
 */
export async function lastFinishedIntegrityRun(db: DbExecutor): Promise<JobRunRow | undefined> {
  const [row] = await db
    .select({ run: jobRuns, staffId: s.staffUsers.id, staffName: s.staffUsers.name })
    .from(jobRuns)
    .leftJoin(s.staffUsers, eq(s.staffUsers.id, jobRuns.triggeredBy))
    .where(and(eq(jobRuns.job, INTEGRITY_JOB), sql`${jobRuns.status} not in ('running', 'skipped')`))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1);
  if (!row) return undefined;
  return {
    run: row.run,
    triggeredBy: row.staffId === null || row.staffName === null ? null : { id: row.staffId, name: row.staffName },
  };
}

/**
 * When the newest run that passed every check finished.
 *
 * @param db the database
 * @returns the end time, or `null` when no run ever passed every check
 */
export async function lastCleanIntegrityFinish(db: DbExecutor): Promise<Date | null> {
  const [row] = await db
    .select({ finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, INTEGRITY_JOB),
        eq(jobRuns.status, 'succeeded'),
        sql`(${jobRuns.result}->>'failedChecks') = '0'`,
      ),
    )
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1);
  return row?.finishedAt ?? null;
}

/**
 * The accounts that differ in the newest succeeded integrity run.
 *
 * Why: scenario system-integrity step 2: the message of a `ledger.mismatch_count` alert names the account and the difference, which only the run's
 * findings know (the alert keeps the count). The first {@link Finding}s are the ones the run stored (at most 20).
 *
 * @param db the database
 * @returns the findings of the `accounts_match_lines` check and how many accounts differ in all; none before the first succeeded run
 */
export async function lastAccountDifferences(db: DbExecutor): Promise<{ findings: Finding[]; count: number }> {
  const [row] = await db
    .select({ result: jobRuns.result })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, INTEGRITY_JOB), eq(jobRuns.status, 'succeeded')))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(1);
  const check = checksFromResult(row?.result).find((item) => item.key === 'accounts_match_lines');
  return { findings: check?.findings ?? [], count: check?.count ?? 0 };
}
