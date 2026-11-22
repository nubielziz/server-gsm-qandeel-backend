// A failed job through the real queue workers (decision 054): BullMQ's stored reason and stack, the job_runs row, the log lines and the
// failed-jobs list keep the SQLSTATE and names of a database failure, never its statement or bound values (the marker). Real Postgres and
// Redis (a private BullMQ prefix); the waits are polls for the effect.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import {
  type JobProcessor,
  QueueProcessor,
  QueueWorkersModule,
  QueuesService,
  UnrecoverableError,
} from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { JobRunsModule, JobRunsService } from '@src/modules/health';
import { QueueAdminService } from '@src/modules/health/application/queue-admin.service';
import { type TestApp, createTestApp } from '../../support/app';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { drizzleFailure } from '../../support/db-failure';
import { DB_FAILURE_MARKER, insertRefusedJobRun } from '../../support/db-failure-routes';
import { eventually } from '../../support/infra';
import { logSink } from '../../support/log-sink';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

setDefaultTimeout(60_000);

const PROBE_JOB = 'db_failure_probe';
const PERMANENT_JOB = 'db_failure_permanent_probe';

/** Runs the refused insert inside a recorded run, as every recorded job does. */
@Injectable()
@QueueProcessor('files', PROBE_JOB)
class DbFailureProcessor implements JobProcessor<Record<string, never>, unknown> {
  constructor(
    private readonly db: DbService,
    private readonly runs: JobRunsService,
  ) {}

  process(): Promise<unknown> {
    return this.runs.run({ job: PROBE_JOB, trigger: 'schedule' }, () => insertRefusedJobRun(this.db));
  }
}

/** Throws a permanent failure whose message embeds a database statement. */
@Injectable()
@QueueProcessor('files', PERMANENT_JOB)
class PermanentFailureProcessor implements JobProcessor<Record<string, never>, unknown> {
  process(): Promise<unknown> {
    return Promise.reject(new UnrecoverableError(`x: ${drizzleFailure().message}`));
  }
}

const prefix = testBullPrefix();
let t: TestApp;

beforeAll(async () => {
  await testDb();
  t = await createTestApp({
    imports: [QueueWorkersModule, JobRunsModule],
    providers: [DbFailureProcessor, PermanentFailureProcessor],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const files = () => t.app.get(QueuesService, { strict: false }).queue('files');

describe('a failed job', () => {
  it('keeps no statement or value in its stored failure, its run record or the logs', async () => {
    logSink.clear();
    const added = await files().add(PROBE_JOB, {}, { attempts: 1 });
    const job = await eventually(async () => {
      const current = await files().getJob(added.id!);
      return current?.failedReason ? current : undefined;
    }, 30_000);
    expect(job.failedReason).toContain('Database error 23514');
    expect(job.failedReason).not.toContain(DB_FAILURE_MARKER);
    expect((job.stacktrace ?? []).join('\n')).not.toContain(DB_FAILURE_MARKER);
    expect((job.stacktrace ?? []).join('\n')).not.toContain('Failed query');

    const { db } = await testDb();
    const [run] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, PROBE_JOB)).orderBy(desc(s.jobRuns.id));
    expect(run).toMatchObject({ status: 'failed' });
    expect(run!.error).toContain('Database error 23514');
    expect(run!.error).not.toContain(DB_FAILURE_MARKER);

    await eventually(() =>
      Promise.resolve(logSink.lines.some((line) => String(line.msg).includes(PROBE_JOB)) ? true : undefined),
    );
    for (const line of logSink.lines) expect(JSON.stringify(line)).not.toContain(DB_FAILURE_MARKER);

    const failed = await t.app.get(QueueAdminService, { strict: false }).failed('files', { start: 0, end: 20 });
    expect(JSON.stringify(failed)).not.toContain(DB_FAILURE_MARKER);
  });

  it('an UnrecoverableError stays permanent after it is cleaned', async () => {
    const added = await files().add(PERMANENT_JOB, {}, { attempts: 3, backoff: { type: 'fixed', delay: 10 } });
    const job = await eventually(async () => {
      const current = await files().getJob(added.id!);
      return current?.failedReason ? current : undefined;
    }, 30_000);
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toBe('x: [database statement removed]');
    expect((job.stacktrace ?? []).join('\n')).not.toContain(DB_FAILURE_MARKER);
  });
});
