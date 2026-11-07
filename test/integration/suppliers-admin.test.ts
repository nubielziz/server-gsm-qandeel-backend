// The supplier admin routes of feature 6: add, list, show, change and delete a supplier, test the connection, sync (through the real
// queue and a worker), the supplier's services, the import and the supplier chain of a service, and the call log. Real Postgres and
// Redis, the fake Dhru supplier; the worker runs inside the test process.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { QueueWorkersModule, QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { SupplierJobsModule } from '../../src/modules/suppliers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { auditOf, insertOrderRow, ordersWorld, type OrdersWorld } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService, logsOf } from '../support/suppliers';
import { insertUsd } from '../support/fixtures';

setDefaultTimeout(30_000);

const fake = new FakeDhruSupplier();
const prefix = testBullPrefix();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let encryption: EncryptionService;

beforeAll(async () => {
  t = await createTestApp({
    imports: [SupplierTestModule, QueueWorkersModule, SupplierJobsModule],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*', 'orders:read'], { name: 'Lina S.' });
  encryption = t.app.get(EncryptionService, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  const redis = t.app.get(RedisService, { strict: false });
  await deleteBullKeys(redis.queue, prefix);
  await t.close();
  await closeTestDb();
});
beforeEach(() => fake.reset());

let counter = 0;
const newBody = (overrides: Record<string, unknown> = {}) => ({
  name: `Gulf Server Hub ${(counter += 1)}`,
  driver: 'dhru',
  baseUrl: fake.url,
  username: fake.username,
  apiKey: fake.apiKey,
  currency: 'USD',
  ...overrides,
});

async function createSupplier(overrides: Record<string, unknown> = {}) {
  const res = await staff.post('/admin/suppliers', newBody(overrides));
  expect(res.status).toBe(201);
  return res.body as { id: number; name: string };
}

describe('POST /admin/suppliers', () => {
  it('adds a supplier with the server defaults, the key stored encrypted with its 5-character hint and the format of the driver', async () => {
    const res = await staff.post('/admin/suppliers', newBody({ baseUrl: `${fake.url}/` }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      driver: 'dhru',
      baseUrl: fake.url,
      status: 'active',
      apiKeyHint: fake.apiKey.slice(0, 5),
      creditRate: '1.00000000',
      balance: '0.0000',
      balanceCheckedAt: null,
      lowBalanceAlert: '150.0000',
      maxConcurrency: 5,
      rateLimitPerMin: 60,
      timeoutMs: 15000,
      health: 'up',
      successRate1h: null,
      p50Ms: null,
      openOrders: 0,
      reviewOrders: 0,
      // A new supplier has no balance yet: below its alert amount.
      lowBalance: true,
      runwayDays: null,
      history: [],
      links: [],
    });
    expect(JSON.stringify(res.body)).not.toContain(fake.apiKey);
    const [row] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, res.body.id));
    expect(row).toMatchObject({ paramFormat: 'dhru_xml', apiKeyHint: fake.apiKey.slice(0, 5) });
    expect(row!.apiKeyEnc).toMatch(/^v1:/);
    expect(row!.apiKeyEnc).not.toContain(fake.apiKey);
    expect(encryption.decrypt(row!.apiKeyEnc!, 'suppliers.api_key_enc')).toBe(fake.apiKey);
    const audit = (await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, res.body.id))).at(-1)!;
    expect(audit).toMatchObject({ action: 'added supplier', entityType: 'supplier', actorType: 'staff' });
    expect(JSON.stringify(audit)).not.toContain(fake.apiKey);
  });

  it('derives the JSON format from the rest driver and takes the limits it is given', async () => {
    const res = await staff.post(
      '/admin/suppliers',
      newBody({ driver: 'rest', maxConcurrency: 2, rateLimitPerMin: 10, timeoutMs: 5000, lowBalanceAlert: '20.0000' }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      driver: 'rest',
      maxConcurrency: 2,
      rateLimitPerMin: 10,
      timeoutMs: 5000,
      lowBalanceAlert: '20.0000',
    });
    const [row] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, res.body.id));
    expect(row!.paramFormat).toBe('json');
  });

  it.each([
    ['a name under 2 characters', { name: 'A' }, 'name'],
    ['an unknown driver', { driver: 'soap' }, 'driver'],
    ['an address that is not http(s)', { baseUrl: 'ftp://x.example' }, 'baseUrl'],
    ['no key', { apiKey: '' }, 'apiKey'],
    ['a currency that is not 3 capitals', { currency: 'usd' }, 'currency'],
    ['maxConcurrency 0', { maxConcurrency: 0 }, 'maxConcurrency'],
    ['maxConcurrency 101', { maxConcurrency: 101 }, 'maxConcurrency'],
    ['rateLimitPerMin 10001', { rateLimitPerMin: 10001 }, 'rateLimitPerMin'],
    ['timeoutMs 999', { timeoutMs: 999 }, 'timeoutMs'],
    ['timeoutMs 120001', { timeoutMs: 120001 }, 'timeoutMs'],
    ['a negative low balance alert', { lowBalanceAlert: '-1.0000' }, 'lowBalanceAlert'],
  ])('refuses %s with 422 on %s', async (_what, overrides, field) => {
    const res = await staff.post('/admin/suppliers', newBody(overrides));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field)).toContain(field);
  });

  it('refuses a name already used, ignoring case (422 on name)', async () => {
    const first = await createSupplier({ name: 'Rapid IMEI Twin' });
    const res = await staff.post('/admin/suppliers', newBody({ name: first.name.toUpperCase() }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'name' });
  });

  it('needs suppliers:create', async () => {
    const reader = await adminWith(t, ['suppliers:read']);
    expect((await reader.post('/admin/suppliers', newBody())).status).toBe(403);
  });
});

describe('GET /admin/suppliers and /:id', () => {
  it('lists suppliers with a total, a status filter, a search and the sorts, and shows one', async () => {
    const a = await createSupplier({ name: 'Zeta Supply' });
    const b = await createSupplier({ name: 'Alpha Supply' });
    await staff.patch(`/admin/suppliers/${b.id}`, { status: 'disabled' });
    const list = await staff.get('/admin/suppliers?_start=0&_end=200&q=supply&_sort=name&_order=asc');
    expect(list.status).toBe(200);
    expect(list.total).toBe(2);
    expect(list.body.map((row: { name: string }) => row.name)).toEqual(['Alpha Supply', 'Zeta Supply']);
    expect(
      (await staff.get('/admin/suppliers?status=disabled&q=supply')).body.map((row: { id: number }) => row.id),
    ).toEqual([b.id]);
    expect((await staff.get(`/admin/suppliers/${a.id}`)).body).toMatchObject({
      id: a.id,
      name: 'Zeta Supply',
      history: [],
      links: [],
    });
    expect((await staff.get('/admin/suppliers/999999')).status).toBe(404);
    expect((await staff.get('/admin/suppliers?_sort=balance')).status).toBe(422);
  });

  it('reads creditRate with 8 decimals as stored, and the open and review order counts from the orders', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake, {
      name: 'Counts Supplier',
      creditRate: '1.12345678',
    });
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Counts service' });
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId,
      status: 'processing',
      dispatchState: 'sent',
    });
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId,
      status: 'processing',
      dispatchState: 'needs_attention',
    });
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId,
      status: 'completed',
      dispatchState: 'done',
    });
    const row = (await staff.get('/admin/suppliers?q=Counts%20Supplier')).body[0];
    expect(row.creditRate).toBe('1.12345678');
    expect(row.creditRate).toMatch(/^\d+\.\d{8}$/);
    expect(row).toMatchObject({ openOrders: 2, reviewOrders: 1 });
  });

  it('computes runway days from the 7-day supplier cost and flags a low balance (orders-suppliers-7)', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake, {
      name: 'Runway Supplier',
      balance: '70.0000',
      lowBalanceAlert: '10.0000',
    });
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Runway service' });
    // 49 USD of supplier cost completed in the last 7 days: 7 a day, so 70 lasts 10 days.
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId,
      status: 'completed',
      dispatchState: 'done',
      totalCost: '49.0000',
      unitCost: '49.0000',
      completedAt: new Date(),
    });
    let row = (await staff.get('/admin/suppliers?q=Runway%20Supplier')).body[0];
    expect(row).toMatchObject({ runwayDays: 10, lowBalance: false });
    await world.db.update(s.suppliers).set({ balance: '10.0000' }).where(eq(s.suppliers.id, supplierId));
    row = (await staff.get('/admin/suppliers?q=Runway%20Supplier')).body[0];
    expect(row).toMatchObject({ runwayDays: 1.4, lowBalance: true });
  });

  it('derives health, success rates, latency and the hourly history from the call log', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake, { name: 'Health Supplier' });
    const now = new Date();
    const calls = [
      ...Array.from({ length: 8 }, () => ({ outcome: 'ok' as const, httpStatus: 200, durationMs: 400, error: '' })),
      { outcome: 'error' as const, httpStatus: 500, durationMs: 100, error: 'HTTP 500' },
      { outcome: 'timeout' as const, httpStatus: 0, durationMs: 1500, error: 'Timed out after 1500 ms' },
    ];
    await world.db
      .insert(s.supplierApiLogs)
      .values(calls.map((call) => ({ supplierId, action: 'getimeiorder', createdAt: now, ...call })));
    const detail = (await staff.get(`/admin/suppliers/${supplierId}`)).body;
    // 2 failures in 10 calls over the last 15 minutes is 20 %: down.
    expect(detail).toMatchObject({
      health: 'down',
      successRate1h: 80,
      successRate24h: 80,
      p50Ms: 400,
      p95Ms: expect.any(Number),
    });
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({ successRate: 80, medianMs: 400 });
    expect(detail.history[0].at).toMatch(/:00:00\.000Z$/);
  });

  it('only ever answers up, degraded or down for the health of a supplier', async () => {
    const list = (await staff.get('/admin/suppliers?_end=200')).body as Array<{ health: string }>;
    for (const row of list) expect(['up', 'degraded', 'down']).toContain(row.health);
  });

  it('shows the services linked to a supplier with the cost credit x rate and the whole chain', async () => {
    const first = await insertFakeSupplier(world.db, encryption, fake, {
      name: 'Chain First',
      creditRate: '2.00000000',
    });
    const second = await insertFakeSupplier(world.db, encryption, fake, { name: 'Chain Second' });
    const serviceId = await insertService(world.db, world.auto.categoryId, {
      name: 'Chained service',
      code: 'CHAIN-1',
      slaMinutes: 45,
    });
    const one = await linkService(world.db, serviceId, first, {
      remoteId: 'c1',
      credit: '5.0000',
      name: 'First remote',
    });
    const two = await linkService(world.db, serviceId, second, {
      remoteId: 'c2',
      credit: '6.0000',
      priority: 2,
      name: 'Second remote',
    });
    const detail = (await staff.get(`/admin/suppliers/${first}`)).body;
    expect(detail.links).toEqual([
      {
        serviceId,
        serviceName: 'Chained service',
        serviceCode: 'CHAIN-1',
        serviceStatus: 'active',
        supplierServiceId: one.supplierServiceId,
        supplierServiceName: 'First remote',
        priority: 1,
        cost: '10.0000',
        slaMinutes: 45,
        chain: [
          {
            priority: 1,
            supplierId: first,
            supplierName: 'Chain First',
            supplierServiceId: one.supplierServiceId,
            supplierServiceName: 'First remote',
          },
          {
            priority: 2,
            supplierId: second,
            supplierName: 'Chain Second',
            supplierServiceId: two.supplierServiceId,
            supplierServiceName: 'Second remote',
          },
        ],
      },
    ]);
  });
});

describe('PATCH /admin/suppliers/:id', () => {
  it('changes only the keys sent: a new key replaces the key and its hint, an omitted key keeps both', async () => {
    const { id } = await createSupplier();
    const [before] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
    const same = await staff.patch(`/admin/suppliers/${id}`, { username: 'new-user', maxConcurrency: 3 });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ username: 'new-user', maxConcurrency: 3, apiKeyHint: fake.apiKey.slice(0, 5) });
    const [kept] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
    expect(kept!.apiKeyEnc).toBe(before!.apiKeyEnc);

    const rekeyed = await staff.patch(`/admin/suppliers/${id}`, { apiKey: 'brand-new-secret-key' });
    expect(rekeyed.body.apiKeyHint).toBe('brand');
    const [after] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
    expect(encryption.decrypt(after!.apiKeyEnc!, 'suppliers.api_key_enc')).toBe('brand-new-secret-key');
    expect(after!.apiKeyEnc).not.toBe(before!.apiKeyEnc);
  });

  it("switches the supplier with the demo's verbs in the audit: paused, resumed, disabled, enabled", async () => {
    const { id } = await createSupplier();
    const verbs: string[] = [];
    for (const status of ['paused', 'active', 'disabled', 'active']) {
      expect((await staff.patch(`/admin/suppliers/${id}`, { status })).body.status).toBe(status);
      verbs.push((await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, id))).at(-1)!.action);
    }
    expect(verbs).toEqual(['paused supplier', 'resumed supplier', 'disabled supplier', 'enabled supplier']);
  });

  it('derives the format again when the driver changes, and refuses a taken name, a bad driver and an empty change', async () => {
    const { id } = await createSupplier();
    const other = await createSupplier();
    expect((await staff.patch(`/admin/suppliers/${id}`, { driver: 'rest' })).body.driver).toBe('rest');
    expect((await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id)))[0]!.paramFormat).toBe('json');
    expect(
      (await staff.patch(`/admin/suppliers/${id}`, { name: other.name.toLowerCase() })).body.errors[0],
    ).toMatchObject({ field: 'name' });
    expect((await staff.patch(`/admin/suppliers/${id}`, { driver: 'soap' })).body.errors[0]).toMatchObject({
      field: 'driver',
    });
    expect((await staff.patch(`/admin/suppliers/${id}`, {})).status).toBe(422);
    expect((await staff.patch('/admin/suppliers/999999', { username: 'x' })).status).toBe(404);
  });
});

describe('DELETE /admin/suppliers/:id', () => {
  it('deletes a supplier that was only tested and synced, with the logs of those calls (204)', async () => {
    const { id } = await createSupplier();
    expect((await staff.post(`/admin/suppliers/${id}/test`)).status).toBe(200);
    expect((await staff.post(`/admin/suppliers/${id}/sync`)).status).toBe(200);
    expect((await logsOf(world.db, id)).length).toBeGreaterThan(0);
    expect((await staff.delete(`/admin/suppliers/${id}`)).status).toBe(204);
    expect((await staff.get(`/admin/suppliers/${id}`)).status).toBe(404);
    expect(await world.db.select().from(s.supplierApiLogs).where(eq(s.supplierApiLogs.supplierId, id))).toHaveLength(0);
    expect(await world.db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, id))).toHaveLength(
      0,
    );
    expect((await staff.get('/admin/audit-logs?entityType=supplier')).status).toBe(403);
  });

  it('refuses with SUPPLIER_IN_USE: open orders, order history, a service link, an order call', async () => {
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Delete guard service' });
    const open = await insertFakeSupplier(world.db, encryption, fake, { name: 'In use open' });
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId: open,
      status: 'processing',
      dispatchState: 'sent',
    });
    const openAnswer = await staff.delete(`/admin/suppliers/${open}`);
    expect(openAnswer.status).toBe(409);
    expect(openAnswer.body).toMatchObject({ code: 'SUPPLIER_IN_USE', detail: expect.stringContaining('1 open order') });

    const history = await insertFakeSupplier(world.db, encryption, fake, { name: 'In use history' });
    await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      supplierId: history,
      status: 'completed',
      dispatchState: 'done',
    });
    expect((await staff.delete(`/admin/suppliers/${history}`)).body).toMatchObject({
      code: 'SUPPLIER_IN_USE',
      detail: expect.stringContaining('order history'),
    });

    const linked = await insertFakeSupplier(world.db, encryption, fake, { name: 'In use link' });
    await linkService(world.db, serviceId, linked, { remoteId: 'l1' });
    expect((await staff.delete(`/admin/suppliers/${linked}`)).body).toMatchObject({
      code: 'SUPPLIER_IN_USE',
      detail: expect.stringContaining('still use'),
    });

    const called = await insertFakeSupplier(world.db, encryption, fake, { name: 'In use calls' });
    const order = await insertOrderRow(world.db, {
      serviceId,
      clientId: world.merchant.id,
      status: 'rejected',
      dispatchState: 'done',
    });
    await world.db
      .insert(s.supplierApiLogs)
      .values({ supplierId: called, orderId: order.id, action: 'placeimeiorder' });
    expect((await staff.delete(`/admin/suppliers/${called}`)).body).toMatchObject({ code: 'SUPPLIER_IN_USE' });
    expect((await staff.delete('/admin/suppliers/999999')).status).toBe(404);
  });
});

describe('POST /admin/suppliers/:id/test', () => {
  it('calls accountinfo, saves the balance and logs the call with no order (ok true)', async () => {
    fake.credit = '987.65';
    const { id } = await createSupplier();
    const res = await staff.post(`/admin/suppliers/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      httpStatus: 200,
      accountName: fake.mail,
      balance: '987.6500',
      message: expect.stringContaining('987.6500'),
    });
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
    const [row] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
    expect(row).toMatchObject({ balance: '987.6500' });
    expect(row!.balanceCheckedAt).not.toBeNull();
    expect(await logsOf(world.db, id)).toMatchObject([
      { action: 'accountinfo', orderId: null, httpStatus: 200, error: '', outcome: 'ok' },
    ]);
    expect((await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, id))).at(-1)).toMatchObject({
      action: 'tested connection to',
    });
  });

  it('answers ok false with a readable message when the supplier refuses the key or is down, never a problem', async () => {
    const { id } = await createSupplier({ apiKey: 'wrong-key-wrong' });
    const refused = await staff.post(`/admin/suppliers/${id}/test`);
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ ok: false, message: 'Authentication Failed', httpStatus: 200 });
    expect((await staff.get(`/admin/suppliers/${id}`)).body.balanceCheckedAt).toBeNull();

    fake.forceHttp = 502;
    const down = await staff.post(`/admin/suppliers/${id}/test`);
    expect(down.body).toMatchObject({ ok: false, httpStatus: 502, message: expect.stringContaining('HTTP 502') });

    const unreachable = await createSupplier({ baseUrl: 'http://127.0.0.1:1' });
    const refusedConnection = await staff.post(`/admin/suppliers/${unreachable.id}/test`);
    expect(refusedConnection.body).toMatchObject({ ok: false, httpStatus: null, message: 'Connection failed' });
    expect((await logsOf(world.db, unreachable.id))[0]).toMatchObject({
      httpStatus: 0,
      outcome: 'error',
      error: 'Connection failed',
    });
    expect((await staff.post('/admin/suppliers/999999/test')).status).toBe(404);
  });

  it('answers a call to a rest supplier with a clear refusal', async () => {
    const { id } = await createSupplier({ driver: 'rest' });
    const res = await staff.post(`/admin/suppliers/${id}/test`);
    expect(res.body).toMatchObject({
      ok: false,
      message: expect.stringContaining('REST suppliers are not supported yet'),
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('POST /admin/suppliers/:id/sync', () => {
  it('syncs the services and the balance through the worker, answers the counts and logs both calls with no order', async () => {
    const { id } = await createSupplier();
    const res = await staff.post(`/admin/suppliers/${id}/sync`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ services: 3, added: 3, changed: 0, removed: 0, balance: '1240.5000' });
    expect(res.body.balanceCheckedAt).toMatch(/Z$/);

    const rows = await world.db
      .select()
      .from(s.supplierServices)
      .where(eq(s.supplierServices.supplierId, id))
      .orderBy(s.supplierServices.remoteId);
    expect(rows.map((row) => [row.remoteId, row.name, row.credit, row.type, row.remoteGroup, row.isAvailable])).toEqual(
      [
        ['4411', 'AT&T USA Premier', '13.5000', 'IMEI', 'Carrier unlock', true],
        ['4412', 'Chimera 1 month', '19.8000', 'SERVER', 'Server tools', true],
        ['4413', 'Octoplus Credits x25', '2.5000', 'Credits', 'Credits', true],
      ],
    );
    const [supplier] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
    expect(supplier).toMatchObject({ balance: '1240.5000' });
    expect(supplier!.balanceCheckedAt).not.toBeNull();
    expect(supplier!.pricesSyncedAt).not.toBeNull();
    const logs = await logsOf(world.db, id);
    expect(logs.map((log) => [log.action, log.orderId, log.outcome])).toEqual([
      ['imeiservicelist', null, 'ok'],
      ['accountinfo', null, 'ok'],
    ]);
    expect(logs[0]!.response).toEqual({ services: 3 });
    expect((await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, id))).at(-1)).toMatchObject({
      action: 'synced services from',
    });
  });

  it('counts a changed price, a new service and a removed one, marks price_changed_at and recomputes the effective cost of linked services', async () => {
    const { id } = await createSupplier();
    await staff.post(`/admin/suppliers/${id}/sync`);
    const serviceId = await insertService(world.db, world.auto.categoryId, {
      name: 'Synced link service',
      cost: '10.0000',
      effectiveCost: '13.5000',
    });
    const [remote] = await world.db
      .select()
      .from(s.supplierServices)
      .where(and(eq(s.supplierServices.supplierId, id), eq(s.supplierServices.remoteId, '4411')));
    await world.db.insert(s.serviceSupplierLinks).values({ serviceId, supplierServiceId: remote!.id, priority: 1 });
    await world.db.update(s.suppliers).set({ creditRate: '1' }).where(eq(s.suppliers.id, id));

    fake.services = fake.services.filter((service) => service.id !== '4413');
    fake.services[0]!.credit = '15.2500';
    fake.services.push({
      id: '4414',
      group: 'Carrier unlock',
      type: 'IMEI',
      name: 'Vodafone UK',
      credit: '4.0000',
      time: '1 day',
    });
    const res = await staff.post(`/admin/suppliers/${id}/sync`);
    expect(res.body).toMatchObject({ services: 3, added: 1, changed: 1, removed: 1 });

    const rows = await world.db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, id));
    const byRemote = new Map(rows.map((row) => [row.remoteId, row]));
    expect(byRemote.get('4411')).toMatchObject({ credit: '15.2500' });
    expect(byRemote.get('4411')!.priceChangedAt).not.toBeNull();
    expect(byRemote.get('4412')!.priceChangedAt).toBeNull();
    expect(byRemote.get('4413')).toMatchObject({ isAvailable: false });
    expect(byRemote.get('4414')).toMatchObject({ isAvailable: true, name: 'Vodafone UK' });

    // The supplier's new price is above the service cost: the effective cost (the price floor) follows it, and the old one is kept.
    const [service] = await world.db.select().from(s.services).where(eq(s.services.id, serviceId));
    expect(service).toMatchObject({ effectiveCost: '15.2500' });
    expect(service!.costWas).toBe('13.5000');
  });

  it('answers SUPPLIER_DISABLED for a disabled supplier and SUPPLIER_UNAVAILABLE when the supplier fails during the sync', async () => {
    const disabled = await createSupplier();
    await staff.patch(`/admin/suppliers/${disabled.id}`, { status: 'disabled' });
    const refused = await staff.post(`/admin/suppliers/${disabled.id}/sync`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SUPPLIER_DISABLED' });

    const paused = await createSupplier();
    await staff.patch(`/admin/suppliers/${paused.id}`, { status: 'paused' });
    expect((await staff.post(`/admin/suppliers/${paused.id}/sync`)).status).toBe(200);

    const down = await createSupplier();
    fake.forceHttp = 503;
    const failed = await staff.post(`/admin/suppliers/${down.id}/sync`);
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ code: 'SUPPLIER_UNAVAILABLE', detail: expect.stringContaining('HTTP 503') });
    expect(
      await world.db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, down.id)),
    ).toHaveLength(0);
    expect((await staff.post('/admin/suppliers/999999/sync')).status).toBe(404);
  });

  it('answers SUPPLIER_TIMEOUT when the job is still running after timeout + 5 s, and the job finishes in the background', async () => {
    const { id } = await createSupplier({ timeoutMs: 1000 });
    const queues = t.app.get(QueuesService, { strict: false });
    await queues.queue('supplier-sync').pause();
    try {
      const res = await staff.post(`/admin/suppliers/${id}/sync`);
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({
        code: 'SUPPLIER_TIMEOUT',
        detail: expect.stringContaining('continues in the background'),
      });
    } finally {
      await queues.queue('supplier-sync').resume();
    }
    // The job was queued and runs now.
    for (let waited = 0; waited < 8000; waited += 200) {
      const [row] = await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
      if (row!.pricesSyncedAt !== null) break;
      await Bun.sleep(200);
    }
    expect((await world.db.select().from(s.suppliers).where(eq(s.suppliers.id, id)))[0]!.pricesSyncedAt).not.toBeNull();
  });
});

describe("the supplier's services and the import", () => {
  let supplierId: number;
  let remoteByRemoteId: Map<string, number>;

  beforeAll(async () => {
    fake.reset();
    fake.services = [
      {
        id: 'a1',
        group: 'Carrier unlock',
        type: 'IMEI',
        name: 'Telstra Australia',
        credit: '10.0000',
        time: '1-2 hours',
      },
      { id: 'a2', group: '', type: 'SERVER', name: 'Server pack', credit: '6.0000', time: 'Instant' },
      { id: 'a3', group: 'Credits', type: 'Credits', name: 'Credit bundle', credit: '3.0000', time: '2 hours' },
      { id: 'a4', group: 'Carrier unlock', type: 'IMEI', name: 'Rogers Canada', credit: '8.0000', time: 'soon' },
    ];
    supplierId = (await createSupplier({ name: 'Import Source' })).id;
    await staff.post(`/admin/suppliers/${supplierId}/sync`);
    const rows = await world.db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, supplierId));
    remoteByRemoteId = new Map(rows.map((row) => [row.remoteId, row.id]));
    // Server pack carries a custom field description.
    await world.db
      .update(s.supplierServices)
      .set({
        customFields: [{ fieldname: 'Account User', fieldtype: 'text', description: 'Account name', required: '1' }],
      })
      .where(eq(s.supplierServices.id, remoteByRemoteId.get('a2')!));
  });

  it('lists the synced services with imported and linkedServiceId, filters, searches and sorts them', async () => {
    const serviceId = await insertService(world.db, world.auto.categoryId, {
      name: 'Linked to a1',
      cost: '10.0000',
      effectiveCost: '10.0000',
    });
    await world.db
      .insert(s.serviceSupplierLinks)
      .values({ serviceId, supplierServiceId: remoteByRemoteId.get('a1')!, priority: 1 });
    const all = await staff.get(`/admin/suppliers/${supplierId}/services?_start=0&_end=50&_sort=name&_order=asc`);
    expect(all.status).toBe(200);
    expect(all.total).toBe(4);
    expect(all.body.map((row: { name: string }) => row.name)).toEqual([
      'Credit bundle',
      'Rogers Canada',
      'Server pack',
      'Telstra Australia',
    ]);
    expect(all.body.find((row: { remoteId: string }) => row.remoteId === 'a1')).toMatchObject({
      imported: true,
      linkedServiceId: serviceId,
      credit: '10.0000',
      time: '1-2 hours',
    });
    expect(all.body[0]).not.toHaveProperty('raw');
    expect((await staff.get(`/admin/suppliers/${supplierId}/services?imported=false`)).total).toBe(3);
    expect(
      (await staff.get(`/admin/suppliers/${supplierId}/services?q=canada`)).body.map(
        (row: { remoteId: string }) => row.remoteId,
      ),
    ).toEqual(['a4']);
    expect((await staff.get('/admin/suppliers/999999/services')).status).toBe(404);
  });

  it('previews: new, matching and changed with the previous cost and the suggested price', async () => {
    const [linked] = await world.db.select().from(s.services).where(eq(s.services.name, 'Linked to a1'));
    const matching = await staff.post(`/admin/suppliers/${supplierId}/import/preview`, {
      supplierServiceIds: [remoteByRemoteId.get('a1')!],
    });
    expect(matching.body.items).toEqual([
      {
        supplierServiceId: remoteByRemoteId.get('a1'),
        name: 'Telstra Australia',
        type: 'IMEI',
        state: 'matching',
        serviceId: linked!.id,
        serviceName: 'Linked to a1',
        cost: '10.0000',
        previousCost: null,
        suggestedPrice: null,
      },
    ]);
    await world.db.update(s.services).set({ cost: '9.0000' }).where(eq(s.services.id, linked!.id));
    const preview = await staff.post(`/admin/suppliers/${supplierId}/import/preview`, {
      supplierServiceIds: [remoteByRemoteId.get('a1')!, remoteByRemoteId.get('a4')!],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.items[0]).toMatchObject({
      state: 'changed',
      cost: '10.0000',
      previousCost: '9.0000',
      suggestedPrice: '10.6000',
    });
    expect(preview.body.items[1]).toMatchObject({
      state: 'new',
      serviceId: null,
      cost: '8.0000',
      previousCost: null,
      suggestedPrice: '8.4800',
    });
    expect((await staff.post(`/admin/suppliers/${supplierId}/import/preview`, { supplierServiceIds: [] })).status).toBe(
      422,
    );
    await world.db.update(s.services).set({ cost: '10.0000' }).where(eq(s.services.id, linked!.id));
  });

  it('imports a new item as a service with the defaults, a category, the suggested price, the SLA, a link and its custom fields', async () => {
    const res = await staff.post(`/admin/suppliers/${supplierId}/import`, {
      supplierServiceIds: [remoteByRemoteId.get('a2')!, remoteByRemoteId.get('a4')!],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 2, updated: 0, unchanged: 0 });

    const [server] = await world.db
      .select()
      .from(s.services)
      .where(eq(s.services.code, `IMP-${remoteByRemoteId.get('a2')}`));
    expect(server).toMatchObject({
      name: 'Server pack',
      type: 'server',
      status: 'active',
      fulfillment: 'auto',
      priceMode: 'fixed',
      duplicateRule: 'block_open',
      cost: '6.0000',
      effectiveCost: '6.0000',
      basePrice: '6.3600',
      slaMinutes: 5,
      deliveryTime: 'Instant',
    });
    const [category] = await world.db
      .select()
      .from(s.serviceCategories)
      .where(eq(s.serviceCategories.id, server!.categoryId));
    expect(category).toMatchObject({ name: 'Imported', type: 'server' });
    const [imei] = await world.db
      .select()
      .from(s.services)
      .where(eq(s.services.code, `IMP-${remoteByRemoteId.get('a4')}`));
    const [imeiCategory] = await world.db
      .select()
      .from(s.serviceCategories)
      .where(eq(s.serviceCategories.id, imei!.categoryId));
    expect(imeiCategory).toMatchObject({ name: 'Carrier unlock', type: 'imei' });
    // 'soon' cannot be read: the setting's default of 1440 minutes.
    expect(imei).toMatchObject({ slaMinutes: 1440, basePrice: '8.4800' });
    const [link] = await world.db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.serviceId, server!.id));
    expect(link).toMatchObject({ priority: 1, isActive: true, supplierServiceId: remoteByRemoteId.get('a2') });
    const fields = await world.db.select().from(s.serviceFields).where(eq(s.serviceFields.serviceId, server!.id));
    expect(fields).toMatchObject([
      { key: 'account_user', label: 'Account name', fieldType: 'text', required: true, supplierKey: 'Account User' },
    ]);
    expect(
      (await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, supplierId))).at(-1),
    ).toMatchObject({ action: 'imported services from' });
    // Imported again: both match now.
    expect(
      (await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [remoteByRemoteId.get('a2')!] }))
        .body,
    ).toEqual({ created: 0, updated: 0, unchanged: 1 });
  });

  it('takes the next free code on a collision', async () => {
    const code = `IMP-${remoteByRemoteId.get('a3')}`;
    await world.db
      .update(s.supplierServices)
      .set({ type: 'FILE' })
      .where(eq(s.supplierServices.id, remoteByRemoteId.get('a3')!));
    await insertService(world.db, world.auto.categoryId, { name: 'Squatter', code: code.toLowerCase() });
    const res = await staff.post(`/admin/suppliers/${supplierId}/import`, {
      supplierServiceIds: [remoteByRemoteId.get('a3')!],
    });
    expect(res.body.created).toBe(1);
    expect(
      await world.db
        .select()
        .from(s.services)
        .where(eq(s.services.code, `${code}-2`)),
    ).toHaveLength(1);
  });

  it('updates the cost of a linked service whose supplier price changed, never its price, and counts an archived one as unchanged', async () => {
    const [linked] = await world.db.select().from(s.services).where(eq(s.services.name, 'Linked to a1'));
    await world.db
      .update(s.services)
      .set({ cost: '9.0000', effectiveCost: '10.0000', basePrice: '12.0000' })
      .where(eq(s.services.id, linked!.id));
    const res = await staff.post(`/admin/suppliers/${supplierId}/import`, {
      supplierServiceIds: [remoteByRemoteId.get('a1')!],
    });
    expect(res.body).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect((await world.db.select().from(s.services).where(eq(s.services.id, linked!.id)))[0]).toMatchObject({
      cost: '10.0000',
      basePrice: '12.0000',
    });

    await world.db
      .update(s.services)
      .set({ cost: '9.0000', status: 'disabled', archivedAt: new Date() })
      .where(eq(s.services.id, linked!.id));
    expect(
      (await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [remoteByRemoteId.get('a1')!] }))
        .body,
    ).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect((await world.db.select().from(s.services).where(eq(s.services.id, linked!.id)))[0]).toMatchObject({
      cost: '9.0000',
    });
  });

  it('refuses the whole import when an item has a type that is not imei, server, remote or file (422 on supplierServiceIds)', async () => {
    const credits = remoteByRemoteId.get('a3')!;
    await world.db.update(s.supplierServices).set({ type: 'Credits' }).where(eq(s.supplierServices.id, credits));
    await world.db
      .update(s.serviceSupplierLinks)
      .set({ isActive: false })
      .where(eq(s.serviceSupplierLinks.supplierServiceId, credits));
    await world.db.delete(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.supplierServiceId, credits));
    const before = await world.db.select().from(s.services);
    const res = await staff.post(`/admin/suppliers/${supplierId}/import`, {
      supplierServiceIds: [credits, remoteByRemoteId.get('a4')!],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({
      field: 'supplierServiceIds',
      message: expect.stringContaining('Credit bundle'),
    });
    expect(await world.db.select().from(s.services)).toHaveLength(before.length);
    // An id of another supplier is ignored; nothing of this supplier means 422.
    const other = await createSupplier();
    const foreign = await staff.post(`/admin/suppliers/${other.id}/import`, {
      supplierServiceIds: [remoteByRemoteId.get('a1')!],
    });
    expect(foreign.status).toBe(422);
    expect((await staff.post('/admin/suppliers/999999/import', { supplierServiceIds: [1] })).status).toBe(404);
  });
});

describe('PUT /admin/services/:id/supplier-links', () => {
  it('replaces the chain: renumbers 1..n, answers the steps with names, recomputes the effective cost and audits', async () => {
    const supplierA = await insertFakeSupplier(world.db, encryption, fake, { name: 'Link Alpha' });
    const supplierB = await insertFakeSupplier(world.db, encryption, fake, { name: 'Link Beta' });
    const serviceId = await insertService(world.db, world.auto.categoryId, {
      name: 'Link target',
      cost: '5.0000',
      effectiveCost: '5.0000',
    });
    const a = await linkService(world.db, serviceId, supplierA, {
      remoteId: 'x1',
      credit: '7.0000',
      name: 'Alpha remote',
    });
    const b = await linkService(world.db, serviceId, supplierB, {
      remoteId: 'x2',
      credit: '9.0000',
      name: 'Beta remote',
      priority: 5,
    });
    // The links exist already; a new chain puts Beta first.
    const res = await staff.put(`/admin/services/${serviceId}/supplier-links`, {
      links: [
        { supplierServiceId: a.supplierServiceId, priority: 2 },
        { supplierServiceId: b.supplierServiceId, priority: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        priority: 1,
        supplierId: supplierB,
        supplierName: 'Link Beta',
        supplierServiceId: b.supplierServiceId,
        supplierServiceName: 'Beta remote',
      },
      {
        priority: 2,
        supplierId: supplierA,
        supplierName: 'Link Alpha',
        supplierServiceId: a.supplierServiceId,
        supplierServiceName: 'Alpha remote',
      },
    ]);
    // The first link costs 9.00: that is the new effective cost (the floor of the prices).
    expect((await world.db.select().from(s.services).where(eq(s.services.id, serviceId)))[0]).toMatchObject({
      effectiveCost: '9.0000',
    });
    expect((await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, serviceId))).at(-1)).toMatchObject(
      {
        action: 'changed supplier links of',
        entityType: 'service',
      },
    );
  });

  it('keeps the field map of a link that stays, and unlinks with []', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake);
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Unlink target' });
    const link = await linkService(world.db, serviceId, supplierId, {
      remoteId: 'y1',
      fieldMap: { username: 'AccountUser' },
    });
    expect(
      (
        await staff.put(`/admin/services/${serviceId}/supplier-links`, {
          links: [{ supplierServiceId: link.supplierServiceId, priority: 1 }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await world.db.select().from(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.serviceId, serviceId)))[0],
    ).toMatchObject({ fieldMap: { username: 'AccountUser' }, priority: 1 });
    const cleared = await staff.put(`/admin/services/${serviceId}/supplier-links`, { links: [] });
    expect(cleared.body).toEqual([]);
    expect(
      await world.db.select().from(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.serviceId, serviceId)),
    ).toHaveLength(0);
  });

  it('refuses an unknown or repeated supplier service (422 on links), an unknown service (404) and a missing permission', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake);
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Refusal target' });
    const link = await linkService(world.db, serviceId, supplierId, { remoteId: 'z1' });
    const unknown = await staff.put(`/admin/services/${serviceId}/supplier-links`, {
      links: [{ supplierServiceId: 999_999, priority: 1 }],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'links' });
    const repeated = await staff.put(`/admin/services/${serviceId}/supplier-links`, {
      links: [
        { supplierServiceId: link.supplierServiceId, priority: 1 },
        { supplierServiceId: link.supplierServiceId, priority: 2 },
      ],
    });
    expect(repeated.status).toBe(422);
    expect((await staff.put('/admin/services/999999/supplier-links', { links: [] })).status).toBe(404);
    const reader = await adminWith(t, ['catalog:read']);
    expect((await reader.put(`/admin/services/${serviceId}/supplier-links`, { links: [] })).status).toBe(403);
  });
});

describe('GET /admin/supplier-api-logs', () => {
  it('lists calls newest first without bodies, filters by supplier, order, action and outcome, and shows a call with masked bodies', async () => {
    const supplierId = await insertFakeSupplier(world.db, encryption, fake, { name: 'Log Supplier' });
    const serviceId = await insertService(world.db, world.auto.categoryId, { name: 'Log service' });
    const order = await insertOrderRow(world.db, { serviceId, clientId: world.merchant.id });
    const [first, second] = await world.db
      .insert(s.supplierApiLogs)
      .values([
        {
          supplierId,
          orderId: order.id,
          action: 'placeimeiorder',
          request: { action: 'placeimeiorder', apiaccesskey: '••••••••' },
          response: { SUCCESS: [{ REFERENCEID: '1' }] },
          httpStatus: 200,
          durationMs: 640,
        },
        {
          supplierId,
          orderId: null,
          action: 'accountinfo',
          request: null,
          response: null,
          httpStatus: 0,
          durationMs: 1500,
          error: 'Timed out after 1500 ms',
          outcome: 'timeout',
        },
      ])
      .returning();
    const list = await staff.get(`/admin/supplier-api-logs?supplierId=${supplierId}`);
    expect(list.status).toBe(200);
    expect(list.total).toBe(2);
    expect(list.body.map((row: { id: number }) => row.id)).toEqual([second!.id, first!.id]);
    expect(list.body[0]).toEqual({
      id: second!.id,
      supplierId,
      orderId: null,
      action: 'accountinfo',
      httpStatus: 0,
      durationMs: 1500,
      error: 'Timed out after 1500 ms',
      createdAt: expect.stringMatching(/Z$/),
    });
    expect(list.body[0]).not.toHaveProperty('request');
    expect((await staff.get(`/admin/supplier-api-logs?supplierId=${supplierId}&outcome=timeout`)).total).toBe(1);
    expect((await staff.get(`/admin/supplier-api-logs?orderId=${order.id}`)).body[0].id).toBe(first!.id);
    expect((await staff.get(`/admin/supplier-api-logs?supplierId=${supplierId}&action=placeimeiorder`)).total).toBe(1);

    const detail = await staff.get(`/admin/supplier-api-logs/${first!.id}`);
    expect(detail.body).toMatchObject({
      id: first!.id,
      orderId: order.id,
      request: { apiaccesskey: '••••••••' },
      response: { SUCCESS: [{ REFERENCEID: '1' }] },
    });
    // No body at all is `{}` on the wire, never null.
    expect((await staff.get(`/admin/supplier-api-logs/${second!.id}`)).body).toMatchObject({
      request: {},
      response: {},
    });
    expect((await staff.get('/admin/supplier-api-logs/999999')).status).toBe(404);
  });

  it('needs suppliers:read', async () => {
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/supplier-api-logs')).status).toBe(403);
    expect((await nobody.get('/admin/suppliers')).status).toBe(403);
  });
});

void insertCategory;
void insertUsd;
void auditOf;
