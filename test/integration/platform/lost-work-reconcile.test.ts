// Integration tests of the lost-work reconcile's coordinator (decision 055) on the real application with two fake passes registered on the
// registry: the counts of every pass add up, a pass that throws does not stop the others and the run fails with one short error, a
// scheduled run with nothing to do writes no job_runs row while one that asked again (and every manual run) writes one, and the schedule.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import {
  LOST_WORK_RECONCILE_JOB,
  LOST_WORK_RECONCILE_SCHEDULER,
  type LostWorkApplied,
  LostWorkModule,
  type LostWorkPass,
  type LostWorkPlan,
  LostWorkReconcile,
  LostWorkReconcileProcessor,
  LostWorkRegistry,
} from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { rejectionOf } from '../../support/rejection';

const clock = new TestClock('2026-11-22T09:00:00.000Z');
let t: TestApp;
let db: Database;

/** A pass whose plan and apply the test sets before each run. */
interface FakePass extends LostWorkPass {
  nextPlan: LostWorkPlan | Error;
  nextApplied: LostWorkApplied | Error;
  applied: number;
}

const EMPTY: LostWorkPlan = { checked: 0, unknown: 0, exhausted: 0, items: [] };

function fakePass(kind: string): FakePass {
  const pass: FakePass = {
    kind,
    nextPlan: EMPTY,
    nextApplied: { requested: 0, gaveUp: 0 },
    applied: 0,
    plan: () => (pass.nextPlan instanceof Error ? Promise.reject(pass.nextPlan) : Promise.resolve(pass.nextPlan)),
    apply: () => {
      pass.applied += 1;
      return pass.nextApplied instanceof Error ? Promise.reject(pass.nextApplied) : Promise.resolve(pass.nextApplied);
    },
  };
  return pass;
}

const alpha = fakePass('test_alpha');
const beta = fakePass('test_beta');
const runs = () => db.select().from(s.jobRuns).where(eq(s.jobRuns.job, LOST_WORK_RECONCILE_JOB)).orderBy(s.jobRuns.id);
const processor = () => t.app.get(LostWorkReconcileProcessor, { strict: false });

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, imports: [LostWorkModule] });
  const registry = t.app.get(LostWorkRegistry, { strict: false });
  registry.register(alpha);
  registry.register(beta);
});
beforeEach(async () => {
  await resetDb();
  for (const pass of [alpha, beta]) {
    pass.nextPlan = EMPTY;
    pass.nextApplied = { requested: 0, gaveUp: 0 };
    pass.applied = 0;
  }
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});

describe('the lost-work reconcile (decision 055)', () => {
  it('runs every pass and adds up their counts', async () => {
    alpha.nextPlan = {
      checked: 3,
      unknown: 1,
      exhausted: 1,
      items: [
        { action: 'request', id: 1 },
        { action: 'give_up', id: 2 },
      ],
    };
    alpha.nextApplied = { requested: 1, gaveUp: 1 };
    beta.nextPlan = { checked: 2, unknown: 0, exhausted: 0, items: [{ action: 'request', id: 5 }] };
    beta.nextApplied = { requested: 1, gaveUp: 0 };
    const result = await t.app.get(LostWorkReconcile, { strict: false }).run();
    expect(result.passes.test_alpha).toEqual({ checked: 3, unknown: 1, exhausted: 1, requested: 1, gaveUp: 1 });
    expect(result.passes.test_beta).toEqual({ checked: 2, unknown: 0, exhausted: 0, requested: 1, gaveUp: 0 });
    expect(result).toMatchObject({ requested: 2, gaveUp: 1, unknown: 1 });
    // A pass with nothing planned is not asked to apply.
    beta.nextPlan = EMPTY;
    beta.applied = 0;
    alpha.nextPlan = EMPTY;
    await t.app.get(LostWorkReconcile, { strict: false }).run();
    expect(beta.applied).toBe(0);
  });

  it('a pass that throws does not stop the others; the run then fails with one error that names its kind and no statement text', async () => {
    alpha.nextPlan = { checked: 1, unknown: 0, exhausted: 0, items: [{ action: 'request', id: 1 }] };
    alpha.nextApplied = new Error('Failed query: update refunds set note = $1\nparams: the customer note');
    beta.nextPlan = { checked: 1, unknown: 0, exhausted: 0, items: [{ action: 'request', id: 2 }] };
    beta.nextApplied = { requested: 1, gaveUp: 0 };
    const error = await rejectionOf(t.app.get(LostWorkReconcile, { strict: false }).run());
    expect(String(error)).toContain(
      'Lost work reconcile: 1 pass(es) failed (test_alpha); first failure: Failed query: update refunds',
    );
    expect(String(error)).not.toContain('customer note');
    expect(beta.applied).toBe(1);

    // A pass whose plan throws: the others still plan and apply.
    alpha.nextPlan = new Error('the queue Redis went away');
    beta.applied = 0;
    const planned = await rejectionOf(t.app.get(LostWorkReconcile, { strict: false }).run());
    expect(String(planned)).toContain('(test_alpha); first failure: the queue Redis went away');
    expect(beta.applied).toBe(1);
  });

  it('a scheduled run with nothing to do writes no job_runs row; one that asked again writes one; a manual run always does', async () => {
    expect((await processor().process({ data: {} })).requested).toBe(0);
    expect(await runs()).toHaveLength(0);

    alpha.nextPlan = { checked: 1, unknown: 0, exhausted: 0, items: [{ action: 'request', id: 9 }] };
    alpha.nextApplied = { requested: 1, gaveUp: 0 };
    expect((await processor().process({ data: {} })).requested).toBe(1);
    const recorded = await runs();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(recorded[0]!.result).toMatchObject({
      test_alpha: { checked: 1, unknown: 0, exhausted: 0, requested: 1, gaveUp: 0 },
      test_beta: { checked: 0, unknown: 0, exhausted: 0, requested: 0, gaveUp: 0 },
      unknown: 0,
    });

    alpha.nextPlan = EMPTY;
    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: LOST_WORK_RECONCILE_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    await processor().process({ data: { runId: manual!.id } });
    const afterManual = await runs();
    expect(afterManual).toHaveLength(2);
    expect(afterManual.find((run) => run.id === manual!.id)).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      processed: 0,
    });

    // A failing pass is recorded as a failed run.
    alpha.nextPlan = new Error('the queue Redis went away');
    await rejectionOf(processor().process({ data: {} }));
    expect((await runs()).at(-1)).toMatchObject({ trigger: 'schedule', status: 'failed' });
  });

  it('registers the scheduler lost-work-reconcile every 5 minutes on maintenance', () => {
    const entry = t.app
      .get(JobSchedulerRegistry, { strict: false })
      .list()
      .find((spec) => spec.id === LOST_WORK_RECONCILE_SCHEDULER);
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: LOST_WORK_RECONCILE_JOB, every: 300_000 });
  });
});
