// The cancel window of a website order (decision 075): an order placed through the portal for a service that allows cancellation is not
// claimed for two minutes, so the merchant can cancel it; the portal shows until when. Dhru orders and services without cancellation are
// sent at once; a cancel inside the window wins and the later run does nothing; the sweep and a staff send leave the wait alone. Real
// Postgres and Redis (a private BullMQ prefix, no workers), a TestClock, the fake Dhru supplier; the test calls the job's logic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { CANCEL_WINDOW_MS } from '@src/modules/orders';
import { DISPATCH_REQUEUE_AFTER_MS, DispatchSweep, SupplierDispatch } from '@src/modules/suppliers';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { credentialsFor, dhruClient } from '../../support/machine-orders';
import { fundWallet } from '../../support/money';
import {
  IMEIS,
  auditOf,
  eventsOf,
  json,
  orderRow,
  ordersWorld,
  portalFor,
  walletOf,
  type OrdersWorld,
} from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { FakeDhruSupplier, SupplierTestModule, automaticRoute, logsOf } from '../../support/suppliers';

const clock = new TestClock();
const fake = new FakeDhruSupplier();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let serviceId = 0;
let supplierId = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [SupplierTestModule], env: { BULL_PREFIX: prefix } });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'suppliers:*']);
  dispatch = t.app.get(SupplierDispatch, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  fake.reset();
  await fundWallet(world.db, world.merchant.id, '100');
});

/** A fresh automatic service with its own fake-backed supplier; `allowCancel` switches the merchant's cancel on. */
async function route(allowCancel: boolean): Promise<void> {
  ({ serviceId, supplierId } = await automaticRoute(
    world.db,
    t.app.get(EncryptionService, { strict: false }),
    fake,
    world.auto.categoryId,
  ));
  await world.db.update(s.services).set({ allowCancel }).where(eq(s.services.id, serviceId));
}

/** The merchant places one order of the current service on the website; returns its id. */
async function placeOnWebsite(imei: string = IMEIS[0]): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** The order as the merchant's portal shows it. */
async function merchantView(orderId: number) {
  return json(await (await portalFor(t, world.merchant.id)).get(`/client/orders/${orderId}`));
}

const run = (orderId: number, lastAttempt = false) => dispatch.run(orderId, { lastAttempt });
const sends = () => fake.callsOf('placeimeiorder').length;

describe('a website order of a service that allows cancellation', () => {
  it('is not claimed inside its window: no claim, no event, no call, no audit, and the portal shows until when it can be cancelled', async () => {
    await route(true);
    const placedAt = clock.now();
    const orderId = await placeOnWebsite();
    const until = new Date(placedAt.getTime() + CANCEL_WINDOW_MS);

    expect(await run(orderId)).toEqual({ status: 'deferred', until });
    // The last attempt changes nothing: the wait is not a failure.
    clock.advance(CANCEL_WINDOW_MS - SECOND);
    expect(await run(orderId, true)).toEqual({ status: 'deferred', until });

    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'pending',
      dispatchState: 'pending',
      sentAt: null,
    });
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual(['created', 'hold']);
    expect(await auditOf(world.db, orderId)).toHaveLength(0);
    expect(sends()).toBe(0);
    expect(await logsOf(world.db, supplierId)).toHaveLength(0);

    expect(await merchantView(orderId)).toMatchObject({
      canCancel: true,
      cancelUntil: until.toISOString(),
      cancelBlocked: null,
      canVerify: false,
      verifyUntil: null,
      // The service does not allow verification: that reason comes before "not completed".
      verifyBlocked: 'not_allowed',
    });
    const list = json(await (await portalFor(t, world.merchant.id)).get('/client/orders'));
    expect(list.find((row: { id: number }) => row.id === orderId)).toMatchObject({ cancelUntil: until.toISOString() });
  });

  it('is claimed and sent once the window has passed, and then says it was sent', async () => {
    await route(true);
    const orderId = await placeOnWebsite(IMEIS[1]);
    expect((await run(orderId)).status).toBe('deferred');

    clock.advance(CANCEL_WINDOW_MS);
    expect(await run(orderId)).toEqual({ status: 'sent', reference: fake.referenceOf(1) });
    expect(sends()).toBe(1);
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual([
      'created',
      'hold',
      'dispatch',
      'ack',
    ]);
    expect(await merchantView(orderId)).toMatchObject({
      canCancel: false,
      cancelUntil: null,
      cancelBlocked: 'already_sent',
    });
  });

  it('can be cancelled inside its window: the hold goes back, and the later run sends nothing', async () => {
    await route(true);
    const before = await walletOf(world.db, world.merchant.id);
    const orderId = await placeOnWebsite(IMEIS[2]);
    expect((await run(orderId)).status).toBe('deferred');

    clock.advance(CANCEL_WINDOW_MS / 2);
    const portal = await portalFor(t, world.merchant.id);
    expect((await portal.post(`/client/orders/${orderId}/cancel`)).statusCode).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
    expect(await walletOf(world.db, world.merchant.id)).toEqual(before);
    expect(await merchantView(orderId)).toMatchObject({ canCancel: false, cancelUntil: null, cancelBlocked: 'closed' });

    // The job that waited runs at the end of the window: the guarded claim finds nothing to send.
    clock.advance(CANCEL_WINDOW_MS);
    expect(await run(orderId)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(sends()).toBe(0);
    expect((await eventsOf(world.db, orderId)).some((event) => event.type === 'dispatch')).toBe(false);
  });

  it("reads the service's switch when the job runs, not when the order was placed", async () => {
    await route(true);
    const switchedOff = await placeOnWebsite(IMEIS[3]);
    await world.db.update(s.services).set({ allowCancel: false }).where(eq(s.services.id, serviceId));
    expect((await run(switchedOff)).status).toBe('sent');
    expect(await merchantView(switchedOff)).toMatchObject({ cancelUntil: null, cancelBlocked: 'not_allowed' });

    await route(false);
    const switchedOn = await placeOnWebsite(IMEIS[4]);
    await world.db.update(s.services).set({ allowCancel: true }).where(eq(s.services.id, serviceId));
    expect((await run(switchedOn)).status).toBe('deferred');
  });

  it('is left alone by the dispatch sweep while it waits, and after the window until its five minutes', async () => {
    await route(true);
    const orderId = await placeOnWebsite(IMEIS[0]);
    expect((await run(orderId)).status).toBe('deferred');
    const sweep = t.app.get(DispatchSweep, { strict: false });
    const planned = async () => (await sweep.plan()).items.filter((item) => item.orderId === orderId);
    expect(await planned()).toEqual([]);
    clock.advance(CANCEL_WINDOW_MS);
    expect(await planned()).toEqual([]);
    clock.advance(DISPATCH_REQUEUE_AFTER_MS - CANCEL_WINDOW_MS - SECOND);
    expect(await planned()).toEqual([]);
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'pending', sentAt: null });
  });

  it('waits for its window when staff press send: the request on its way is left alone and the run still waits', async () => {
    await route(true);
    const orderId = await placeOnWebsite(IMEIS[1]);
    expect((await run(orderId)).status).toBe('deferred');
    expect((await staff.post(`/admin/orders/${orderId}/dispatch`, {})).status).toBe(204);
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual(['created', 'hold']);
    expect((await run(orderId)).status).toBe('deferred');
    expect(sends()).toBe(0);
  });
});

describe('orders that never wait', () => {
  it('sends a Dhru order of a service that allows cancellation at once', async () => {
    await route(true);
    const dhru = dhruClient(t, await credentialsFor(t, world.db, world.merchant.id));
    const answer = await dhru.call('placeimeiorder', { ID: serviceId, IMEI: IMEIS[2] });
    const orderId = Number(answer.SUCCESS?.[0]?.REFERENCEID);
    expect((await orderRow(world.db, orderId)).source).toBe('dhru');
    expect(await run(orderId)).toEqual({ status: 'sent', reference: fake.referenceOf(1) });
  });

  it('sends a website order of a service without cancellation at once', async () => {
    await route(false);
    const orderId = await placeOnWebsite(IMEIS[3]);
    expect(await run(orderId)).toEqual({ status: 'sent', reference: fake.referenceOf(1) });
    expect(await merchantView(orderId)).toMatchObject({
      canCancel: false,
      cancelUntil: null,
      cancelBlocked: 'not_allowed',
    });
  });
});
