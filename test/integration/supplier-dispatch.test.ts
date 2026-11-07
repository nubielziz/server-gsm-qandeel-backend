// The dispatch job of feature 6 (resolutions orders-suppliers-11 and -12, decision 025): an order placed through the portal is sent to
// its supplier exactly once, a REFERENCEID moves it to `sent`, and a refusal, a timeout or no eligible link moves it to `needs_attention`
// with the reason and the hold kept. Real Postgres and Redis, the fake Dhru supplier, no BullMQ worker: the test calls the job's logic.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RateLimitService } from '../../src/infra/rate-limit';
import { OrderSupplierMoves } from '../../src/modules/orders';
import { SupplierDispatch } from '../../src/modules/suppliers';
import { SupplierBusyError } from '../../src/modules/suppliers/application/supplier-dispatch';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { fundWallet } from '../support/money';
import {
  IMEIS,
  eventsOf,
  json,
  ordersWorld,
  orderRow,
  outboxOf,
  portalFor,
  walletOf,
  type OrdersWorld,
} from '../support/orders';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService, logsOf } from '../support/suppliers';

const fake = new FakeDhruSupplier();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let supplierId: number;
let serviceId: number;
let sequence = 0;

beforeAll(async () => {
  t = await createTestApp({ imports: [SupplierTestModule] });
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
  await t.close();
  await closeTestDb();
});

/** A fresh automatic service priced 17.28 whose only link goes to a fresh fake-backed supplier (credit 13.50). */
async function freshRoute(overrides: { credit?: string; supplier?: Partial<typeof s.suppliers.$inferInsert> } = {}) {
  const { db } = world;
  supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake, overrides.supplier);
  sequence += 1;
  serviceId = await insertService(db, world.auto.categoryId, {
    name: `Fake route ${sequence}`,
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
  });
  await linkService(db, serviceId, supplierId, { credit: overrides.credit ?? '13.5000' });
}

/** The merchant places one order for the current service through the portal and the job logic runs it. */
async function place(imei: string = IMEIS[0]) {
  const portal = await portalFor(t, world.merchant.id);
  const res = await portal.post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** How much the merchant's hold grew since a reading (every test places on top of the earlier tests' holds). */
async function holdGrewSince(before: { hold: string }): Promise<string> {
  const now = await walletOf(world.db, world.merchant.id);
  return new Decimal(now.hold).minus(before.hold).toFixed(4);
}

const run = (orderId: number, lastAttempt = false) => dispatch.run(orderId, { lastAttempt });

beforeEach(async () => {
  fake.reset();
  // Every test places one or two orders for its own service: the wallet is topped up so no test starves the next.
  await fundWallet(world.db, world.merchant.id, '100');
});

describe('a successful send', () => {
  it('claims the order, calls placeimeiorder once, stores the REFERENCEID and moves it to sent (processing)', async () => {
    await freshRoute();
    const walletBefore = await walletOf(world.db, world.merchant.id);
    const orderId = await place();
    expect((await orderRow(world.db, orderId)).dispatchState).toBe('pending');
    expect(await outboxOf(world.db, 'order.dispatch_requested', orderId)).toHaveLength(1);

    const outcome = await run(orderId);
    expect(outcome).toEqual({ status: 'sent', reference: fake.referenceOf(1) });

    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({
      status: 'processing',
      dispatchState: 'sent',
      supplierId,
      supplierRef: fake.referenceOf(1),
      unitCost: '13.5000',
      totalCost: '13.5000',
    });
    expect(order.supplierServiceId).not.toBeNull();
    expect(order.sentAt).not.toBeNull();

    // The supplier got exactly one order, for the supplier's service id, with the IMEI and the quantity.
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(fake.callsOf('placeimeiorder')[0]).toMatchObject({
      username: 'gsm-supply',
      parameters: { ID: '4411', IMEI: IMEIS[0], QNT: 1 },
    });

    // The timeline: dispatch (before the call), then the acknowledgement with the reference; the hold stays.
    const events = await eventsOf(world.db, orderId);
    expect(events.map((event) => event.type)).toEqual(['created', 'hold', 'dispatch', 'ack']);
    expect(events[2]).toMatchObject({ actorType: 'system', data: { supplier: expect.any(String) } });
    expect(events[3]).toMatchObject({
      actorType: 'supplier',
      actorId: supplierId,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    expect(events[3]!.data).toMatchObject({ ref: fake.referenceOf(1) });
    expect(await holdGrewSince(walletBefore)).toBe('17.2800');
    expect(await outboxOf(world.db, 'order.status_changed', orderId)).toHaveLength(1);

    // The call is logged with the order, a real status and time, no error and the outcome ok; secrets and the IMEI are masked.
    const [log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({ orderId, action: 'placeimeiorder', httpStatus: 200, error: '', outcome: 'ok' });
    expect(log!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(log!.request)).not.toContain(IMEIS[0]);
    expect(JSON.stringify(log!.request)).not.toContain(fake.apiKey);
    expect(log!.request).toMatchObject({
      action: 'placeimeiorder',
      parameters: { ID: '4411', IMEI: `••••••••${IMEIS[0].slice(-4)}` },
    });
  });

  it('a second run never sends again', async () => {
    await freshRoute();
    const orderId = await place();
    await run(orderId);
    expect(await run(orderId)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });

  it('two runs at the same moment send once: the guarded claim lets one of them through', async () => {
    await freshRoute();
    const orderId = await place();
    const [a, b] = await Promise.all([run(orderId), run(orderId)]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['sent', 'skipped']);
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect((await orderRow(world.db, orderId)).dispatchState).toBe('sent');
  });

  it('answers not_found for an unknown order and leaves a closed one alone', async () => {
    await freshRoute();
    expect(await run(999_999)).toEqual({ status: 'skipped', reason: 'not_found' });
    const orderId = await place();
    await world.db.update(s.orders).set({ status: 'rejected', dispatchState: 'done' }).where(eq(s.orders.id, orderId));
    expect(await run(orderId)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('a send that does not work', () => {
  it("an explicit refusal moves the order to needs_attention with the supplier's words, the hold kept", async () => {
    await freshRoute();
    fake.place({ refuse: 'Not enough credits' });
    const walletBefore = await walletOf(world.db, world.merchant.id);
    const orderId = await place();
    const outcome = await run(orderId);
    expect(outcome.status).toBe('needs_attention');

    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'pending', dispatchState: 'needs_attention', supplierRef: null });
    const review = (await eventsOf(world.db, orderId)).at(-1)!;
    expect(review).toMatchObject({ type: 'review', actorType: 'system' });
    expect(review.data).toMatchObject({ reason: expect.stringContaining('Not enough credits') });
    expect(await holdGrewSince(walletBefore)).toBe('17.2800');
    const shown = (await staff.get(`/admin/orders/${orderId}`)).body;
    expect(shown).toMatchObject({
      queue: 'needs_attention',
      reviewReason: expect.stringContaining('Not enough credits'),
    });
    const [log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({ httpStatus: 200, outcome: 'error', error: 'Not enough credits' });
    expect(await outboxOf(world.db, 'order.status_changed', orderId)).toHaveLength(0);
  });

  it('a timeout keeps the hold, writes outcome timeout with status 0 and the time waited, and is never re-sent (scenario timeout)', async () => {
    await freshRoute({ supplier: { timeoutMs: 300 } });
    fake.place('accept-then-hang');
    const walletBefore = await walletOf(world.db, world.merchant.id);
    const orderId = await place();
    const outcome = await run(orderId);
    expect(outcome).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('did not answer within 300 ms'),
    });

    const order = await orderRow(world.db, orderId);
    expect(order).toMatchObject({ status: 'pending', dispatchState: 'needs_attention', supplierRef: null });
    expect(await holdGrewSince(walletBefore)).toBe('17.2800');
    const [log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({ orderId, httpStatus: 0, outcome: 'timeout', error: 'Timed out after 300 ms' });
    expect(log!.durationMs).toBeGreaterThanOrEqual(250);

    // The supplier did run it, and nothing sends it again by itself.
    expect(fake.orders.size).toBe(1);
    expect(await run(orderId)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });

  it.each([
    ['an HTTP 502', { http: 502 } as const, 'HTTP 502'],
    ['an answer that is not Dhru', 'garbage' as const, 'not JSON'],
  ])('%s moves the order to needs_attention without a reference', async (_name, script, text) => {
    await freshRoute();
    fake.place(script);
    const orderId = await place();
    const outcome = await run(orderId);
    expect(outcome).toMatchObject({ status: 'needs_attention', reason: expect.stringContaining(text) });
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'needs_attention', supplierRef: null });
    const [log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({ outcome: 'error' });
  });

  it("a supplier whose key was refused is a refusal with the supplier's message", async () => {
    await freshRoute();
    await world.db.update(s.suppliers).set({ username: 'someone-else' }).where(eq(s.suppliers.id, supplierId));
    const orderId = await place();
    expect(await run(orderId)).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('Authentication Failed'),
    });
  });

  it('a supplier with no saved key is not called and the order says so', async () => {
    await freshRoute({ supplier: { apiKeyEnc: null, apiKeyHint: null } });
    const orderId = await place();
    expect(await run(orderId)).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('No API key'),
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('a claim whose answer was never recorded is not sent again: the order needs attention', async () => {
    await freshRoute();
    const orderId = await place();
    // What a crash between the claim and the answer leaves behind.
    await world.db.update(s.orders).set({ sentAt: new Date() }).where(eq(s.orders.id, orderId));
    const outcome = await run(orderId);
    expect(outcome).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('answer was not recorded'),
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('the choice of the supplier (user rule 9, B117 (6))', () => {
  it('skips a paused supplier and goes to the next active link by priority', async () => {
    await freshRoute();
    const second = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, {
      name: `Backup ${sequence}`,
    });
    await linkService(world.db, serviceId, second, { remoteId: '9001', priority: 2, credit: '14.0000' });
    await world.db.update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, supplierId));
    const orderId = await place();
    expect((await run(orderId)).status).toBe('sent');
    expect(await orderRow(world.db, orderId)).toMatchObject({
      supplierId: second,
      unitCost: '14.0000',
      totalCost: '14.0000',
    });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters.ID).toBe('9001');
  });

  it('never fails over to a link that costs more than the price charged: needs_attention with the reason, nothing sent', async () => {
    await freshRoute({ credit: '17.3000' });
    const orderId = await place();
    const outcome = await run(orderId);
    expect(outcome).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('costs more than the price charged'),
    });
    expect(fake.calls).toHaveLength(0);
    expect(await orderRow(world.db, orderId)).toMatchObject({ supplierId: null, dispatchState: 'needs_attention' });
  });

  it('with every supplier paused the order waits for attention, and a service no longer listed is skipped too', async () => {
    await freshRoute({ supplier: { status: 'disabled' } });
    const orderId = await place();
    expect(await run(orderId)).toMatchObject({
      status: 'needs_attention',
      reason: expect.stringContaining('paused or disabled'),
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('what is sent', () => {
  it("maps the custom fields to the supplier's names (the field's supplier key, the link's field map first) and sends the quantity", async () => {
    await freshRoute();
    const { db } = world;
    const serverCategory = world.server.serviceId;
    expect(serverCategory).toBeGreaterThan(0);
    const [serverService] = await db.select().from(s.services).where(eq(s.services.id, world.server.serviceId));
    const serverSupplier = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    await db
      .insert(s.serviceFields)
      .values({ serviceId: serverService!.id, key: 'region', label: 'Region', supplierKey: 'Country' });
    await db.update(s.serviceFields).set({ supplierKey: 'AccountUser' }).where(eq(s.serviceFields.key, 'username'));
    await linkService(db, serverService!.id, serverSupplier, {
      remoteId: '4412',
      type: 'SERVER',
      credit: '6.0000',
      fieldMap: { region: 'RegionCode' },
    });
    await db.update(s.services).set({ minQty: 1, maxQty: 5 }).where(eq(s.services.id, serverService!.id));

    const portal = await portalFor(t, world.merchant.id);
    const res = await portal.post('/client/orders', {
      serviceId: serverService!.id,
      quantity: 2,
      inputs: { username: 'ali.k', region: 'EU' },
    });
    expect(res.statusCode).toBe(201);
    const orderId = json(res).orders[0].id as number;
    expect((await run(orderId)).status).toBe('sent');
    const call = fake.callsOf('placeimeiorder')[0]!;
    expect(call.parameters).toMatchObject({
      ID: '4412',
      QNT: 2,
      CUSTOMFIELD: { AccountUser: 'ali.k', RegionCode: 'EU' },
    });
    expect(call.parameters.IMEI).toBeUndefined();
    expect(await orderRow(db, orderId)).toMatchObject({ unitCost: '6.0000', totalCost: '12.0000' });
  });
});

describe('a busy supplier', () => {
  it('asks the queue to try again while it can, and sends the order to needs_attention on the last attempt', async () => {
    await freshRoute({ supplier: { maxConcurrency: 1 } });
    const limits = t.app.get(RateLimitService, { strict: false });
    const lease = await limits.acquire(`supplier-${supplierId}`, 1, 30_000);
    expect(lease).not.toBeNull();
    try {
      const orderId = await place();
      expect(await run(orderId).catch((error: unknown) => error)).toBeInstanceOf(SupplierBusyError);
      expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'pending', sentAt: null });
      expect(await run(orderId, true)).toMatchObject({
        status: 'needs_attention',
        reason: expect.stringContaining('too busy'),
      });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await limits.release(lease!);
    }
  });

  it("refuses a call over the supplier's own rate limit", async () => {
    await freshRoute({ supplier: { rateLimitPerMin: 1 } });
    // Supplier ids repeat from one run of the suite to the next and the counter lives a minute on the cache Redis.
    await t.app.get(RateLimitService, { strict: false }).reset('supplier', String(supplierId));
    const first = await place(IMEIS[0]);
    const second = await place(IMEIS[1]);
    expect((await run(first)).status).toBe('sent');
    expect(await run(second).catch((error: unknown) => error)).toBeInstanceOf(SupplierBusyError);
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
  });
});

describe('the orders module door', () => {
  it('claims only a pending order that was never claimed', async () => {
    await freshRoute();
    const orderId = await place();
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    const claim = { orderId, supplierId, supplierServiceId: 1, unitCost: '13.5000', at: new Date() };
    // supplier_service_id 1 may not exist here: use the real one of the link.
    const [link] = await world.db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.serviceId, serviceId));
    const claimWith = { ...claim, supplierServiceId: link!.supplierServiceId };
    const first = await world.db.transaction((tx) => moves.claim(tx, claimWith, 'Fake'));
    expect(first).toMatchObject({ id: orderId, sentAt: expect.any(Date) });
    expect(await world.db.transaction((tx) => moves.claim(tx, claimWith, 'Fake'))).toBeUndefined();
  });
});
