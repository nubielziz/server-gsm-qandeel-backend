// Integration tests of JobRunsService (decision 020) on the test database: the run log of scheduled and manual jobs. A run
// is recorded from start to finish, a failing job is recorded and rethrown, overlapping runs of one job are skipped or
// refused (also when they start at the same moment), a manual run is adopted, and stuck runs can be failed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { DbModule, schema as s } from '../../src/infra/db';
import { JobRunsModule, JobRunsService } from '../../src/modules/health';
import { type InfraHarness, createInfra } from '../support/infra';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { expectRejection } from '../support/rejection';

let harness: InfraHarness;
let jobRuns: JobRunsService;

beforeAll(async () => {
  await testDb();
  harness = await createInfra({ modules: [DbModule, JobRunsModule], env: { DATABASE_URL_TEST: TEST_DATABASE_URL } });
  jobRuns = harness.get(JobRunsService);
});
afterAll(async () => {
  await harness.close();
  await closeTestDb();
});
beforeEach(resetDb);

const rowsOf = async (job?: string) => {
  const { db } = await testDb();
  return job
    ? db.select().from(s.jobRuns).where(eq(s.jobRuns.job, job)).orderBy(s.jobRuns.id)
    : db.select().from(s.jobRuns);
};

/** A promise that the test settles by hand, to hold a job in the middle of its work. */
function gate() {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('start and finish', () => {
  it('records a run that has started, with no end yet', async () => {
    const run = await jobRuns.start({ job: 'ledger_integrity', trigger: 'schedule' });
    expect(run).toMatchObject({
      job: 'ledger_integrity',
      trigger: 'schedule',
      status: 'running',
      finishedAt: null,
      durationMs: null,
      processed: null,
      error: null,
      triggeredBy: null,
      result: {},
    });
    expect(run.startedAt).toBeInstanceOf(Date);
    expect((await jobRuns.findRunning('ledger_integrity'))?.id).toBe(run.id);
    expect(await jobRuns.findRunning('other_job')).toBeUndefined();
  });

  it('closes it with the status, the duration, the items handled, the result and the error', async () => {
    const run = await jobRuns.start({ job: 'price_sync', trigger: 'schedule' });
    await Bun.sleep(120);
    const done = await jobRuns.finish(run.id, {
      status: 'succeeded',
      processed: 1480,
      result: { updated: 1480, failedSuppliers: 0 },
    });
    expect(done).toMatchObject({
      id: run.id,
      status: 'succeeded',
      processed: 1480,
      result: { updated: 1480, failedSuppliers: 0 },
      error: null,
    });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    expect(done?.durationMs).toBeGreaterThanOrEqual(100);
    expect(done?.durationMs).toBeLessThan(5_000);
    expect(await jobRuns.findRunning('price_sync')).toBeUndefined();
  });

  it('closes a run only once: a second finish changes nothing', async () => {
    const run = await jobRuns.start({ job: 'price_sync', trigger: 'schedule' });
    await jobRuns.finish(run.id, { status: 'failed', error: 'boom' });
    expect(await jobRuns.finish(run.id, { status: 'succeeded', processed: 5 })).toBeUndefined();
    const [row] = await rowsOf('price_sync');
    expect(row).toMatchObject({ status: 'failed', error: 'boom', processed: 0 });
  });

  it('remembers who started a manual run', async () => {
    const { db } = await testDb();
    const [role] = await db
      .insert(s.roles)
      .values({ name: 'Owner', permissions: ['*'] })
      .returning({ id: s.roles.id });
    const [staff] = await db
      .insert(s.staffUsers)
      .values({ email: 'owner@example.com', name: 'Owner', roleId: role!.id })
      .returning({ id: s.staffUsers.id });
    const run = await jobRuns.start({ job: 'ledger_integrity', trigger: 'manual', triggeredBy: staff!.id });
    expect(run).toMatchObject({ trigger: 'manual', triggeredBy: staff!.id, status: 'running' });
  });
});

describe('run (the wrapper processors use)', () => {
  it('runs the work between a running row and a succeeded one, and keeps the report', async () => {
    let seenInside: string | undefined;
    const done = await jobRuns.run({ job: 'accruals', trigger: 'schedule' }, async (run) => {
      seenInside = (await rowsOf('accruals'))[0]?.status;
      expect(run.status).toBe('running');
      return { processed: 214, result: { accruals: 214 } };
    });
    expect(seenInside).toBe('running');
    expect(done).toMatchObject({
      job: 'accruals',
      status: 'succeeded',
      processed: 214,
      result: { accruals: 214 },
      error: null,
    });
    expect(done.durationMs).not.toBeNull();
    expect(await rowsOf('accruals')).toHaveLength(1);
  });

  it('records a job that returns nothing as succeeded with zero items', async () => {
    const done = await jobRuns.run({ job: 'reminders', trigger: 'schedule' }, () => Promise.resolve());
    expect(done).toMatchObject({ status: 'succeeded', processed: 0, result: {} });
  });

  it('records "nothing to do" as skipped when the job says so', async () => {
    const done = await jobRuns.run({ job: 'data_retention', trigger: 'schedule' }, () =>
      Promise.resolve({ skipped: true, result: { reason: 'retention is switched off' } }),
    );
    expect(done).toMatchObject({ status: 'skipped', result: { reason: 'retention is switched off' } });
  });

  it('records a failing job as failed with its message, and throws the same error on', async () => {
    const boom = new Error('supplier balance check failed: 3 suppliers did not answer');
    const reason = await expectRejection(
      jobRuns.run({ job: 'supplier_balance', trigger: 'schedule' }, () => Promise.reject(boom)),
    );
    expect(reason).toBe(boom);
    const [row] = await rowsOf('supplier_balance');
    expect(row).toMatchObject({ status: 'failed', error: boom.message, processed: 0 });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(await jobRuns.findRunning('supplier_balance')).toBeUndefined();
  });

  it('cuts a very long error message', async () => {
    await expectRejection(
      jobRuns.run({ job: 'price_sync', trigger: 'schedule' }, () => Promise.reject(new Error('x'.repeat(5_000)))),
    );
    const [row] = await rowsOf('price_sync');
    expect(row?.error).toHaveLength(1_000);
    expect(row?.error?.endsWith('...')).toBe(true);
  });

  it('writes one run per attempt, so a retried job shows every try', async () => {
    let attempt = 0;
    const work = () => {
      attempt++;
      return attempt < 3 ? Promise.reject(new Error(`try ${attempt}`)) : Promise.resolve({ processed: 1 });
    };
    await expectRejection(jobRuns.run({ job: 'fx_refresh', trigger: 'schedule' }, work));
    await expectRejection(jobRuns.run({ job: 'fx_refresh', trigger: 'schedule' }, work));
    await jobRuns.run({ job: 'fx_refresh', trigger: 'schedule' }, work);
    expect((await rowsOf('fx_refresh')).map((row) => row.status)).toEqual(['failed', 'failed', 'succeeded']);
  });

  it('adopts the row of a manual run that was inserted before the job was queued', async () => {
    const started = await jobRuns.start({ job: 'ledger_integrity', trigger: 'manual', overlap: 'refuse' });
    const done = await jobRuns.run({ job: 'ledger_integrity', trigger: 'manual', runId: started.id }, () =>
      Promise.resolve({ processed: 48_213, result: { checks: 4 } }),
    );
    expect(done).toMatchObject({ id: started.id, status: 'succeeded', processed: 48_213 });
    expect(await rowsOf('ledger_integrity')).toHaveLength(1);
  });

  it('does not run the work again for a run that was already closed (for example by the reaper)', async () => {
    const started = await jobRuns.start({ job: 'ledger_integrity', trigger: 'manual' });
    await jobRuns.finish(started.id, { status: 'failed', error: 'The worker stopped before this run finished.' });
    let ran = false;
    const result = await jobRuns.run({ job: 'ledger_integrity', trigger: 'manual', runId: started.id }, () => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('fails when the run to adopt does not exist', async () => {
    await expectRejection(
      jobRuns.run({ job: 'x_job', trigger: 'manual', runId: 987_654 }, () => Promise.resolve()),
      /does not exist/,
    );
  });
});

describe('overlapping runs of one job', () => {
  it('skips a second run while the first is going on, and records why', async () => {
    const hold = gate();
    let calls = 0;
    const first = jobRuns.run({ job: 'ledger_integrity', trigger: 'schedule' }, async () => {
      calls++;
      await hold.promise;
      return { processed: 1 };
    });
    while (!(await jobRuns.findRunning('ledger_integrity'))) await Bun.sleep(5);
    const running = (await jobRuns.findRunning('ledger_integrity'))!;

    const second = await jobRuns.run({ job: 'ledger_integrity', trigger: 'schedule' }, () => {
      calls++;
      return Promise.resolve();
    });
    expect(second.status).toBe('skipped');
    expect(second.result).toMatchObject({ runningRunId: running.id });
    expect(second.finishedAt).not.toBeNull();
    expect(calls).toBe(1);

    hold.open();
    expect((await first).status).toBe('succeeded');
    // Once the first run is over, the next one runs.
    const third = await jobRuns.run({ job: 'ledger_integrity', trigger: 'schedule' }, () => Promise.resolve());
    expect(third.status).toBe('succeeded');
  });

  it('lets exactly one of two runs that start at the same moment do the work', async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      await Bun.sleep(150);
      return { processed: 1 };
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => jobRuns.run({ job: 'price_sync', trigger: 'schedule' }, work)),
    );
    expect(calls).toBe(1);
    expect(results.map((run) => run.status).sort()).toEqual(['skipped', 'skipped', 'skipped', 'succeeded']);
    expect((await rowsOf('price_sync')).filter((row) => row.status === 'running')).toHaveLength(0);
  });

  it('refuses a manual run with 409 JOB_ALREADY_RUNNING while the job is going on', async () => {
    await jobRuns.start({ job: 'ledger_integrity', trigger: 'schedule' });
    const reason = await expectRejection(
      jobRuns.start({ job: 'ledger_integrity', trigger: 'manual', overlap: 'refuse' }),
      AppError,
    );
    expect(reason).toMatchObject({ code: 'JOB_ALREADY_RUNNING', status: 409 });
    expect(await rowsOf('ledger_integrity')).toHaveLength(1);
  });

  it('allows overlap when asked to, and never blocks a different job', async () => {
    await jobRuns.start({ job: 'ledger_integrity', trigger: 'schedule' });
    const another = await jobRuns.start({ job: 'ledger_integrity', trigger: 'schedule', overlap: 'allow' });
    const other = await jobRuns.start({ job: 'price_sync', trigger: 'schedule', overlap: 'refuse' });
    expect(another.status).toBe('running');
    expect(other.status).toBe('running');
  });
});

describe('failStuck', () => {
  it('fails runs that have been running for too long, and leaves young and finished runs alone', async () => {
    const { db } = await testDb();
    const stuck = await jobRuns.start({ job: 'ledger_integrity', trigger: 'schedule' });
    const young = await jobRuns.start({ job: 'price_sync', trigger: 'schedule' });
    const finished = await jobRuns.start({ job: 'fx_refresh', trigger: 'schedule' });
    await jobRuns.finish(finished.id, { status: 'succeeded' });
    await db
      .update(s.jobRuns)
      .set({ startedAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(s.jobRuns.id, stuck.id));

    expect(await jobRuns.failStuck(2 * 3_600_000)).toBe(1);
    const rows = Object.fromEntries((await rowsOf()).map((row) => [row.id, row]));
    expect(rows[stuck.id]).toMatchObject({ status: 'failed', error: 'The worker stopped before this run finished.' });
    expect(rows[stuck.id]?.durationMs).toBeGreaterThanOrEqual(3 * 3_600_000 - 60_000);
    expect(rows[young.id]?.status).toBe('running');
    expect(rows[finished.id]?.status).toBe('succeeded');
    // The guard no longer sees a run of the stuck job, so a new one can start.
    expect((await jobRuns.start({ job: 'ledger_integrity', trigger: 'manual', overlap: 'refuse' })).status).toBe(
      'running',
    );
    expect(await jobRuns.failStuck(2 * 3_600_000)).toBe(0);
  });
});
