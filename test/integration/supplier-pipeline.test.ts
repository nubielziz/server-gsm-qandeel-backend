// The supplier pipeline the way the worker wires it (feature 6, decision 020): placing an order writes the outbox row, the relay hands it to
// the `supplier-dispatch` queue, the queue worker runs the dispatch job against a fake Dhru supplier, a `poll` job on `supplier-poll`
// settles the order, and the scheduled `price_sync` of `supplier-sync` goes through the suppliers and is recorded in `job_runs`. Real
// Postgres and Redis (a private BullMQ prefix), real workers; the waits are polls for the effect.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { QueueWorkersModule, QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { OutboxRelayModule } from '../../src/modules/platform';
import { SUPPLIER_SCHEDULERS, SupplierJobsModule } from '../../src/modules/suppliers';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { eventually } from '../support/infra';
import { IMEIS, eventsOf, json, orderRow, ordersWorld, portalFor, type OrdersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, automaticRoute } from '../support/suppliers';

setDefaultTimeout(40_000);

const fake = new FakeDhruSupplier();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let serviceId = 0;
let supplierId = 0;

beforeAll(async () => {
  t = await createTestApp({
    imports: [SupplierTestModule, QueueWorkersModule, OutboxRelayModule, SupplierJobsModule],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  ({ serviceId, supplierId } = await automaticRoute(
    world.db,
    t.app.get(EncryptionService, { strict: false }),
    fake,
    world.auto.categoryId,
  ));
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the supplier pipeline through the real queues', () => {
  it('relays the dispatch row of a placed order, sends it to the supplier and stores its REFERENCEID, then a poll job settles it', async () => {
    const { db, merchant } = world;
    const res = await (await portalFor(t, merchant.id)).post('/client/orders', { serviceId, imei: IMEIS[0] });
    expect(res.statusCode).toBe(201);
    const orderId = json(res).orders[0].id as number;

    const sent = await eventually(async () => {
      const order = await orderRow(db, orderId);
      return order.dispatchState === 'sent' ? order : undefined;
    }, 20_000);
    expect(sent).toMatchObject({ status: 'processing', supplierId, supplierRef: fake.referenceOf(1) });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect((await eventsOf(db, orderId)).map((event) => event.type)).toEqual(['created', 'hold', 'dispatch', 'ack']);

    // The relay marked the outbox row as handed over; a second relay pass sends nothing again.
    const outbox = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.aggregateId, orderId));
    expect(
      outbox.filter((row) => row.type === 'order.dispatch_requested').every((row) => row.processedAt !== null),
    ).toBe(true);

    fake.finish(fake.referenceOf(1), 4, 'Unlocked: 8842');
    await t.app.get(QueuesService, { strict: false }).add('supplier-poll', 'poll', { orderId });
    const done = await eventually(async () => {
      const order = await orderRow(db, orderId);
      return order.status === 'completed' ? order : undefined;
    }, 20_000);
    expect(done).toMatchObject({ dispatchState: 'done', resultCode: 'Unlocked: 8842' });
  });

  it('a refused order stops in needs_attention and the queue does not send it again, whatever the attempts', async () => {
    const { db, merchant } = world;
    fake.place({ refuse: 'Not enough credits' });
    const res = await (await portalFor(t, merchant.id)).post('/client/orders', { serviceId, imei: IMEIS[1] });
    const orderId = json(res).orders[0].id as number;
    const stopped = await eventually(async () => {
      const order = await orderRow(db, orderId);
      return order.dispatchState === 'needs_attention' ? order : undefined;
    }, 20_000);
    expect(stopped.supplierRef).toBeNull();
    await Bun.sleep(1500);
    expect(fake.callsOf('placeimeiorder').filter((call) => call.parameters.IMEI === IMEIS[1])).toHaveLength(1);
  });

  it('registers the three schedules of the supplier jobs and runs the price sync through every supplier, recorded in job_runs', async () => {
    const { db } = world;
    const queues = t.app.get(QueuesService, { strict: false });
    const schedulers = await queues.queue('supplier-poll').getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key)).toContain(SUPPLIER_SCHEDULERS.poll);
    const syncSchedulers = await queues.queue('supplier-sync').getJobSchedulers();
    expect(syncSchedulers.map((scheduler) => scheduler.key).sort()).toEqual(
      [SUPPLIER_SCHEDULERS.balanceCheck, SUPPLIER_SCHEDULERS.priceSync].sort(),
    );

    await queues.add('supplier-sync', 'price_sync', {});
    const run = await eventually(async () => {
      const [row] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, 'price_sync'));
      return row?.status === 'succeeded' ? row : undefined;
    }, 20_000);
    expect(run).toMatchObject({ trigger: 'schedule', processed: 1 });
    const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(supplier!.pricesSyncedAt).not.toBeNull();
    expect(
      await db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, supplierId)),
    ).not.toHaveLength(0);

    await queues.add('supplier-sync', 'balance_check', {});
    const check = await eventually(async () => {
      const [row] = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, 'balance_check'));
      return row?.status === 'succeeded' ? row : undefined;
    }, 20_000);
    expect(check).toMatchObject({ processed: 1 });
  });
});
