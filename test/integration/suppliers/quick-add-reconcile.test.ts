// Integration tests of the lost-work pass of Quick add runs (decision 055, feature 26) on the real application, Postgres and the queue Redis
// (a private BullMQ prefix): a queued run whose `supplier.quick_add` job was lost is asked for again, and a run that staff started again
// meanwhile (the start closes the old run) is not, nor one another run asked for after the plan. "Lost" stands for what a queue Redis that
// lost its data leaves: the event is handed over (processed, at the clock's time) and no job of its id exists. The clock moves; nothing is
// backdated.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { type Database, DbService, schema as s } from '@src/infra/db';
import { QueuesService, queueJobId } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { LostWorkModule, LostWorkReconcile } from '@src/modules/platform';
import { SupplierJobsModule } from '@src/modules/suppliers';
import { QUICK_ADD_EVENT, QuickAddOutbox } from '@src/modules/suppliers/application/quick-add-outbox';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-22T09:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [LostWorkModule, SupplierJobsModule] });
});
beforeEach(async () => {
  clock.set('2026-11-22T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const reconcile = () => t.app.get(LostWorkReconcile, { strict: false }).run();
const requestsOf = (runId: number) =>
  db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, QUICK_ADD_EVENT), eq(s.outboxEvents.aggregateId, runId)))
    .orderBy(desc(s.outboxEvents.id));

/** A supplier with one synced service the quick add can create. */
async function supplierWithService(): Promise<number> {
  const [supplier] = await db
    .insert(s.suppliers)
    .values({ name: 'Quick Source', driver: 'dhru', baseUrl: 'https://supplier.example', paramFormat: 'dhru_xml' })
    .returning({ id: s.suppliers.id });
  await db.insert(s.supplierServices).values({
    supplierId: supplier!.id,
    remoteId: 'r1',
    remoteGroup: 'Apple',
    type: 'IMEI',
    name: 'Remote one',
    credit: '10.0000',
    time: '1-2 hours',
  });
  return supplier!.id;
}

/** Starts a quick add through the route (a `queued` run and its event) and returns the run id. */
async function start(supplierId: number): Promise<number> {
  const res = await staff.post(`/admin/suppliers/${supplierId}/quick-add`, { scope: 'all' });
  expect(res.status).toBe(202);
  return res.body.id as number;
}

/** The relay handed the newest request over and the queue then lost its job. */
async function loseNewest(runId: number): Promise<void> {
  const [newest] = await requestsOf(runId);
  await db.update(s.outboxEvents).set({ processedAt: clock.now() }).where(eq(s.outboxEvents.id, newest!.id));
  await t.app.get(QueuesService).queue('imports').remove(queueJobId('outbox', newest!.id));
}

describe('the Quick add pass of the lost-work reconcile (decision 055)', () => {
  it('asks again for a queued Quick add run whose job was lost', async () => {
    const supplierId = await supplierWithService();
    const runId = await start(supplierId);
    await loseNewest(runId);
    clock.advance(11 * MINUTE);

    expect((await reconcile()).passes.quick_add_runs).toMatchObject({ checked: 1, requested: 1 });
    const [again] = await requestsOf(runId);
    expect(again?.payload).toMatchObject({ runId, supplierId, reconcile: true });
    expect(again?.processedAt).toBeNull();
  });

  it('a run that staff started again meanwhile is not asked for', async () => {
    const supplierId = await supplierWithService();
    const first = await start(supplierId);
    await loseNewest(first);
    clock.advance(11 * MINUTE);
    // The old run reads as stalled; a new start closes it and queues a run of its own.
    staff = await adminWith(t, ['suppliers:*', 'catalog:*']);
    const second = await start(supplierId);
    expect(second).not.toBe(first);

    expect((await reconcile()).passes.quick_add_runs).toMatchObject({ checked: 1, requested: 0 });
    expect(await requestsOf(first)).toHaveLength(1);
    expect(await requestsOf(second)).toHaveLength(1);
  });

  it('a request another run wrote after the plan is seen under the run lock: no second request', async () => {
    const supplierId = await supplierWithService();
    const runId = await start(supplierId);
    await loseNewest(runId);
    clock.advance(11 * MINUTE);
    const coordinator = t.app.get(LostWorkReconcile, { strict: false });
    const plans = await coordinator.plan();
    expect(plans.plans.get('quick_add_runs')?.items).toEqual([{ action: 'request', id: runId, data: { supplierId } }]);
    // Meanwhile another run (a manual one beside the schedule) asked first; its request is not relayed yet, so it is live.
    await t.app
      .get(DbService)
      .runInTransaction(({ tx }) =>
        t.app.get(QuickAddOutbox, { strict: false }).requested(tx, runId, supplierId, { reconcile: true }),
      );

    expect((await coordinator.apply(plans)).passes.quick_add_runs).toMatchObject({ requested: 0 });
    expect(await requestsOf(runId)).toHaveLength(2);
  });
});
