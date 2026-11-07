// Integration tests of REST API v1 (feature 7a, ALIGNMENT § 7) on the real application: the service catalog, the account and its statement,
// the order routes with their refusals, the cursor lists and the key's rate-limit headers. Idempotency and uploads have their own files.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import { OrderTransitions } from '../../src/modules/orders';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type MachineCredentials, body, clearApiKeyCaches, credentialsFor, v1Client } from '../support/machine-orders';
import {
  IMEIS,
  type OrdersWorld,
  eventsOf,
  ledgerOf,
  orderRow,
  ordersWorld,
  outboxOf,
  walletOf,
} from '../support/orders';

const HOUR = 3_600_000;
const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;
let v1: ReturnType<typeof v1Client>;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  v1 = v1Client(t, creds.key);
});

/** Places an order over REST v1 and returns the response. */
const place = (serviceId: number, imei: string = IMEIS[0], extra: Record<string, unknown> = {}, client = v1) =>
  client.post('/v1/orders', { serviceId, imei, ...extra });

/** Selects the wallet account of a merchant (not its hold account). */
const walletAccountOf = (clientId: number) =>
  and(
    eq(s.ledgerAccounts.ownerType, 'client'),
    eq(s.ledgerAccounts.ownerId, clientId),
    eq(s.ledgerAccounts.kind, 'client_wallet'),
  );

/** Moves an order the way staff or the supplier jobs do. */
async function move(
  orderId: number,
  action: { kind: 'accept' } | { kind: 'reply' } | { kind: 'reject' },
  text = 'done',
) {
  const db = t.app.get(DbService, { strict: false });
  await db.runInTransaction(({ tx }) =>
    t.app.get(OrderTransitions).apply(tx, {
      orderId,
      action,
      actor: { type: 'staff', id: 1 },
      ...(action.kind === 'reply' ? { code: text } : action.kind === 'reject' ? { reason: text } : {}),
    }),
  );
}

describe('the key: authentication, scopes and limits on every v1 route', () => {
  it('refuses a call without a key, with a wrong key or with a key that lacks the scope, as problem+json', async () => {
    const anonymous = await v1Client(t, undefined).get('/v1/account');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['content-type']).toContain('application/problem+json');
    expect(body(anonymous)).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect((await v1Client(t, 'gsm_wrongwrongwrongwrongwrongwrong').get('/v1/account')).statusCode).toBe(401);

    const { db } = await testDb();
    const readOnly = await credentialsFor(t, db, world.other.id, { scopes: ['orders:read'] });
    const client = v1Client(t, readOnly.key);
    expect((await client.get('/v1/orders')).statusCode).toBe(200);
    for (const [method, url] of [
      ['GET', '/v1/account'],
      ['GET', '/v1/transactions'],
      ['GET', '/v1/services'],
      ['POST', '/v1/orders'],
    ] as const) {
      const res = method === 'GET' ? await client.get(url) : await client.post(url, { serviceId: 1 });
      expect(res.statusCode, url).toBe(403);
      expect(body(res).code, url).toBe('FORBIDDEN');
    }
  });

  it('refuses a revoked key at once, a key of a merchant waiting for approval, and an address the key does not allow', async () => {
    const { db } = await testDb();
    expect((await v1.get('/v1/account')).statusCode).toBe(200);
    await db.update(s.apiKeys).set({ revokedAt: clock.now() }).where(eq(s.apiKeys.id, creds.keyId));
    await clearApiKeyCaches(t);
    expect((await v1.get('/v1/account')).statusCode).toBe(401);

    const pending = await credentialsFor(t, db, world.other.id);
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.other.id));
    await clearApiKeyCaches(t);
    const refused = await v1Client(t, pending.key).get('/v1/account');
    expect(refused.statusCode).toBe(403);
    expect(body(refused).code).toBe('ACCOUNT_PENDING_APPROVAL');

    const locked = await credentialsFor(t, db, world.merchant.id, { allowedIps: ['203.0.113.0/24'] });
    const fromElsewhere = await v1Client(t, locked.key).get('/v1/account', {}, '198.51.100.9');
    expect(fromElsewhere.statusCode).toBe(403);
    expect(body(fromElsewhere).code).toBe('IP_NOT_ALLOWED');
    expect((await v1Client(t, locked.key).get('/v1/account', {}, '203.0.113.9')).statusCode).toBe(200);
  });

  it("tells the key's limit on every answer after the call was counted, and refuses with 429 and Retry-After beyond it", async () => {
    const { db } = await testDb();
    const limited = await credentialsFor(t, db, world.other.id, { rateLimitPerMin: 3 });
    const client = v1Client(t, limited.key);
    const first = await client.get('/v1/account');
    expect(first.headers['ratelimit-limit']).toBe('3');
    expect(first.headers['ratelimit-remaining']).toBe('2');
    expect(Number(first.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(1);
    expect(Number(first.headers['ratelimit-reset'])).toBeLessThanOrEqual(60);
    // A refusal of the handler carries them too.
    const missing = await client.get('/v1/orders/999999');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['ratelimit-remaining']).toBe('1');
    expect((await client.get('/v1/account')).headers['ratelimit-remaining']).toBe('0');
    const refused = await client.get('/v1/account');
    expect(refused.statusCode).toBe(429);
    expect(body(refused).code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBeDefined();
    expect(refused.headers['ratelimit-limit']).toBe('3');
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    // Another key has its own counter.
    expect((await v1.get('/v1/account')).statusCode).toBe(200);
  });

  it('sends no limit headers when the key was refused before it was counted', async () => {
    const res = await v1Client(t, 'gsm_wrongwrongwrongwrongwrongwrong').get('/v1/account');
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});

describe('GET /v1/services', () => {
  it('lists what the merchant may order at its own price, in id order, never the cost or the supplier', async () => {
    const res = await v1.get('/v1/services');
    expect(res.statusCode).toBe(200);
    const page = body(res);
    expect(page.nextCursor).toBeNull();
    expect(page.data.map((row: { id: number }) => row.id)).toEqual(
      [world.auto.serviceId, world.manual.serviceId, world.server.serviceId].sort((a, b) => a - b),
    );
    const auto = page.data.find((row: { id: number }) => row.id === world.auto.serviceId);
    expect(auto).toMatchObject({
      name: 'AT&T USA Premier Unlock',
      code: 'IMEI-ATT-USA',
      type: 'imei',
      price: '17.2800',
      currency: 'USD',
      category: { id: world.auto.categoryId, name: 'Carrier unlock' },
      allowCancel: false,
      allowVerify: false,
      verifyWindowH: 0,
    });
    expect(JSON.stringify(page)).not.toMatch(/13\.5|cost|supplier/i);
  });

  it('pages by cursor without repeating or skipping a service, and says nextCursor null on the last page', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await v1.get(`/v1/services?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const page = body(res);
      expect(page.data).toHaveLength(1);
      seen.push(page.data[0].id);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(3);
  });

  it('filters by type, category and search text, and refuses a limit out of range or a cursor that is not ours', async () => {
    const byType = body(await v1.get('/v1/services?type=server'));
    expect(byType.data.map((row: { id: number }) => row.id)).toEqual([world.server.serviceId]);
    const byCategory = body(await v1.get(`/v1/services?categoryId=${world.auto.categoryId}`));
    expect(byCategory.data).toHaveLength(2);
    const byText = body(await v1.get('/v1/services?q=manual'));
    expect(byText.data.map((row: { id: number }) => row.id)).toEqual([world.manual.serviceId]);
    for (const query of ['limit=0', 'limit=101', 'limit=x']) {
      const res = await v1.get(`/v1/services?${query}`);
      expect(res.statusCode, query).toBe(422);
      expect(body(res).errors[0].field, query).toBe('limit');
    }
    const bad = await v1.get('/v1/services?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(422);
    expect(body(bad).errors[0].field).toBe('cursor');
  });

  it('never lists a disabled or archived service, or one in a category the merchant group may not see', async () => {
    const { db } = await testDb();
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.manual.serviceId));
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: clock.now() })
      .where(eq(s.services.id, world.server.serviceId));
    const [client] = await db
      .select({ groupId: s.clients.groupId })
      .from(s.clients)
      .where(eq(s.clients.id, world.merchant.id));
    const hidden = await insertCategory(db, { name: 'Staff only', allowedGroupIds: [client!.groupId + 1000] });
    const hiddenService = await insertService(db, hidden, { name: 'Hidden service' });
    const ids = body(await v1.get('/v1/services')).data.map((row: { id: number }) => row.id);
    expect(ids).toEqual([world.auto.serviceId]);
    for (const id of [world.manual.serviceId, world.server.serviceId, hiddenService]) {
      expect((await v1.get(`/v1/services/${id}`)).statusCode, String(id)).toBe(404);
    }
  });

  it('remembers every price it showed (user rule 9), for the list and for one service', async () => {
    const { db } = await testDb();
    await v1.get(`/v1/services?type=server`);
    let listed = await db.select().from(s.listedPrices).where(eq(s.listedPrices.clientId, world.merchant.id));
    expect(listed.map((row) => [row.serviceId, row.price])).toEqual([[world.server.serviceId, '8.0000']]);
    await v1.get(`/v1/services/${world.auto.serviceId}`);
    listed = await db.select().from(s.listedPrices).where(eq(s.listedPrices.clientId, world.merchant.id));
    expect(listed.map((row) => row.serviceId).sort()).toEqual([world.auto.serviceId, world.server.serviceId].sort());
  });
});

describe('GET /v1/services/:id', () => {
  it('answers the service with its custom fields, options and what the merchant may do with its orders', async () => {
    const { db } = await testDb();
    await db
      .update(s.services)
      .set({ allowCancel: true, allowVerify: true, verifyWindowH: 48 })
      .where(eq(s.services.id, world.server.serviceId));
    await db
      .insert(s.serviceOptions)
      .values({ serviceId: world.server.serviceId, list: 'model', value: 'm1', label: 'Model 1' });
    const res = await v1.get(`/v1/services/${world.server.serviceId}`);
    expect(res.statusCode).toBe(200);
    const service = body(res);
    expect(service).toMatchObject({
      id: world.server.serviceId,
      type: 'server',
      price: '8.0000',
      allowCancel: true,
      allowVerify: true,
      verifyWindowH: 48,
      options: [{ list: 'model', value: 'm1', label: 'Model 1' }],
    });
    expect(service.fields).toEqual([
      expect.objectContaining({ key: 'username', label: 'Username', required: true, fieldType: 'text' }),
    ]);
    expect((await v1.get('/v1/services/999999')).statusCode).toBe(404);
    expect((await v1.get('/v1/services/abc')).statusCode).toBe(422);
  });
});

describe('GET /v1/account and GET /v1/transactions', () => {
  it('answers the wallet, the credit and the client group, and follows an order', async () => {
    const { db } = await testDb();
    const before = body(await v1.get('/v1/account'));
    expect(before).toMatchObject({
      balance: '100.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '100.0000',
      currency: 'USD',
    });
    expect(before.group).toEqual({ id: expect.any(Number), name: expect.any(String) });
    expect((await place(world.auto.serviceId)).statusCode).toBe(201);
    expect(body(await v1.get('/v1/account'))).toMatchObject({
      balance: '82.7200',
      reserved: '17.2800',
      available: '82.7200',
    });
    await db.update(s.ledgerAccounts).set({ overdraftLimit: '50.0000' }).where(walletAccountOf(world.merchant.id));
    expect(body(await v1.get('/v1/account')).creditLimit).toBe('50.0000');
  });

  it('pages the statement newest first by cursor, from the merchant side, without repeating or skipping a line', async () => {
    for (const imei of IMEIS.slice(0, 3)) expect((await place(world.auto.serviceId, imei)).statusCode).toBe(201);
    const all = body(await v1.get('/v1/transactions'));
    expect(all.nextCursor).toBeNull();
    const lines = all.data as Array<{ id: number; kind: string; amount: string; balanceAfter: string }>;
    // Newest first; ids fall; an order hold is money going out (negative), the top-up positive.
    expect(lines.map((line) => line.id)).toEqual([...lines.map((line) => line.id)].sort((a, b) => b - a));
    expect(lines[0]).toMatchObject({ kind: 'order_hold', amount: '-17.2800', balanceAfter: '48.1600' });
    expect(lines.at(-1)!.amount).toBe('100.0000');
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const page = body(
        await v1.get(`/v1/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      );
      pages.push(page.data.map((line: { id: number }) => line.id));
      cursor = page.nextCursor;
    } while (cursor !== null && pages.length < 10);
    expect(pages.map((page) => page.length)).toEqual([2, 2]);
    expect(pages.flat()).toEqual(lines.map((line) => line.id));
  });

  it('answers an empty statement for a merchant that never had a wallet line, and 422 for a cursor that is not ours', async () => {
    const { db } = await testDb();
    const { insertWalletMerchant } = await import('../support/money');
    const fresh = await insertWalletMerchant(db, { name: 'Fresh Co' });
    const key = await credentialsFor(t, db, fresh.id);
    expect(body(await v1Client(t, key.key).get('/v1/transactions'))).toEqual({ data: [], nextCursor: null });
    expect((await v1.get('/v1/transactions?cursor=zzz')).statusCode).toBe(422);
  });
});

describe('POST /v1/orders', () => {
  it('places one order at the merchant price: 201, the order as the merchant reads it, the hold and the dispatch row', async () => {
    const { db } = await testDb();
    const res = await place(world.auto.serviceId);
    expect(res.statusCode).toBe(201);
    const order = body(res);
    expect(order).toMatchObject({
      status: 'pending',
      imei: IMEIS[0],
      quantity: 1,
      unitPrice: '17.2800',
      totalPrice: '17.2800',
      currency: 'USD',
      source: 'v1',
      service: { id: world.auto.serviceId, name: 'AT&T USA Premier Unlock', type: 'imei' },
      result: { code: null, comment: null, fileId: null },
      canCancel: false,
      canVerify: false,
      completedAt: null,
    });
    const row = await orderRow(db, order.id);
    expect(row).toMatchObject({ clientId: world.merchant.id, source: 'v1', apiKeyId: creds.keyId, status: 'pending' });
    expect((await eventsOf(db, order.id)).map((event) => [event.type, event.actorType])).toEqual([
      ['created', 'client'],
      ['hold', 'system'],
    ]);
    expect(await ledgerOf(db, order.id)).toEqual([{ kind: 'order_hold', key: `order:${order.id}:hold` }]);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', order.id)).toHaveLength(1);
    // Machine calls of a merchant write no audit row (B121).
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });

  it('places a server service with its inputs and a manual service that waits for staff', async () => {
    const { db } = await testDb();
    const server = await v1.post('/v1/orders', { serviceId: world.server.serviceId, inputs: { username: 'ahmad77' } });
    expect(server.statusCode).toBe(201);
    expect(body(server)).toMatchObject({
      inputs: { username: 'ahmad77' },
      service: { type: 'server' },
      totalPrice: '8.0000',
    });
    const manual = await place(world.manual.serviceId, IMEIS[1]);
    expect(manual.statusCode).toBe(201);
    expect((await orderRow(db, body(manual).id)).dispatchState).toBe('manual');
  });

  it('refuses the input it cannot take, with field errors: an invalid IMEI, a missing field, an unknown key in the body', async () => {
    const badImei = await place(world.auto.serviceId, '123456789012345');
    expect(badImei.statusCode).toBe(422);
    expect(body(badImei).code).toBe('INVALID_IMEI');
    const missingField = await v1.post('/v1/orders', { serviceId: world.server.serviceId, inputs: {} });
    expect(missingField.statusCode).toBe(422);
    expect(body(missingField).errors[0]).toMatchObject({ field: 'inputs.username' });
    const noService = await v1.post('/v1/orders', { imei: IMEIS[0] });
    expect(noService.statusCode).toBe(422);
    expect(body(noService).errors[0].field).toBe('serviceId');
    const { db } = await testDb();
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
  });

  it('refuses an unknown, disabled or archived service (404 / 409), and a balance that cannot cover the price (402)', async () => {
    const { db } = await testDb();
    expect((await place(999999)).statusCode).toBe(404);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.manual.serviceId));
    const disabled = await place(world.manual.serviceId);
    expect(disabled.statusCode).toBe(409);
    expect(body(disabled).code).toBe('SERVICE_DISABLED');
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: clock.now() })
      .where(eq(s.services.id, world.server.serviceId));
    const archived = await v1.post('/v1/orders', { serviceId: world.server.serviceId, inputs: { username: 'x' } });
    expect(archived.statusCode).toBe(404);
    expect(body(archived).code).toBe('NOT_FOUND');
    const poor = await credentialsFor(t, db, world.other.id);
    await db.update(s.ledgerAccounts).set({ balance: '5.0000' }).where(walletAccountOf(world.other.id));
    const short = await place(world.auto.serviceId, IMEIS[0], {}, v1Client(t, poor.key));
    expect(short.statusCode).toBe(402);
    expect(body(short).code).toBe('INSUFFICIENT_FUNDS');
    expect(await db.select().from(s.orders).where(eq(s.orders.clientId, world.other.id))).toHaveLength(0);
  });

  it('refuses a second open order for the same service and IMEI, naming the open order, until the first is closed', async () => {
    const first = body(await place(world.auto.serviceId));
    const again = await place(world.auto.serviceId);
    expect(again.statusCode).toBe(409);
    expect(body(again)).toMatchObject({ code: 'DUPLICATE_ORDER', orderId: first.id });
    await move(first.id, { kind: 'reject' }, 'Wrong IMEI');
    expect((await place(world.auto.serviceId)).statusCode).toBe(201);
  });

  it('refuses an order that costs much more than the listed price with listedPrice and currentPrice, until the list is read again', async () => {
    const { db } = await testDb();
    await v1.get('/v1/services');
    await db.update(s.services).set({ basePrice: '25.0000' }).where(eq(s.services.id, world.auto.serviceId));
    const refused = await place(world.auto.serviceId);
    expect(refused.statusCode).toBe(409);
    expect(body(refused)).toMatchObject({ code: 'PRICE_CHANGED', listedPrice: '17.2800', currentPrice: '25.0000' });
    expect(await db.select().from(s.orders)).toHaveLength(0);
    await v1.get('/v1/services');
    const placed = await place(world.auto.serviceId);
    expect(placed.statusCode).toBe(201);
    expect(body(placed).totalPrice).toBe('25.0000');
  });

  it('refuses a placement during api_orders maintenance with 503 and lets the reads through', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values({
      key: 'maintenance',
      value: {
        enabled: true,
        scope: 'api_orders',
        message: 'Orders are paused.',
        expectedEndAt: null,
        startedAt: '2026-03-01T11:00:00.000Z',
        startedBy: { id: 1, name: 'Rami K.' },
      },
    });
    await t.app.get(MaintenanceService).invalidate();
    const paused = await place(world.auto.serviceId);
    expect(paused.statusCode).toBe(503);
    expect(body(paused).code).toBe('MAINTENANCE');
    expect(
      (await v1.post('/v1/orders/bulk', { orders: [{ serviceId: world.auto.serviceId, imei: IMEIS[0] }] })).statusCode,
    ).toBe(503);
    expect((await v1.get('/v1/orders')).statusCode).toBe(200);
    expect((await v1.get('/v1/account')).statusCode).toBe(200);
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });

  it('never lets parallel placements on one wallet overspend, and places each IMEI once', async () => {
    const { db } = await testDb();
    // 100 USD at 17.28: five orders fit (86.40), the sixth would take the balance to -3.20.
    const imeis = [...IMEIS, '352099001761481', '490154203237518', '356938035643809'];
    const answers = await Promise.all(imeis.map((imei) => place(world.auto.serviceId, imei)));
    expect(answers.filter((res) => res.statusCode === 201)).toHaveLength(5);
    expect(answers.filter((res) => res.statusCode === 402)).toHaveLength(3);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '13.6000', hold: '86.4000' });
    const rich = await credentialsFor(t, db, world.other.id);
    const client = v1Client(t, rich.key);
    const race = await Promise.all(Array.from({ length: 4 }, () => place(world.auto.serviceId, IMEIS[0], {}, client)));
    expect(race.filter((res) => res.statusCode === 201)).toHaveLength(1);
    expect(race.filter((res) => res.statusCode === 409)).toHaveLength(3);
    expect(await walletOf(db, world.other.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });
});

describe('POST /v1/orders/bulk', () => {
  it('answers each item on its own: placed orders and refusals side by side, in the order sent, drawing on one wallet', async () => {
    const { db } = await testDb();
    await db.update(s.ledgerAccounts).set({ balance: '40.0000' }).where(walletAccountOf(world.merchant.id));
    const res = await v1.post('/v1/orders/bulk', {
      orders: [
        { serviceId: world.auto.serviceId, imei: IMEIS[0] },
        { serviceId: world.auto.serviceId, imei: '123456789012345' },
        { serviceId: 999999, imei: IMEIS[1] },
        { serviceId: world.auto.serviceId, imei: IMEIS[2] },
        { serviceId: world.auto.serviceId, imei: IMEIS[3] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const results = body(res).results;
    expect(results.map((result: { index: number }) => result.index)).toEqual([0, 1, 2, 3, 4]);
    expect(results[0]).toMatchObject({ ok: true, order: { status: 'pending', imei: IMEIS[0], source: 'v1' } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'INVALID_IMEI', status: 422 } });
    expect(results[2]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', status: 404 } });
    expect(results[3]).toMatchObject({ ok: true });
    // 40.00 buys two at 17.28; the third would take the balance to -29.12.
    expect(results[4]).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', status: 402 } });
    const stored = await db.select().from(s.orders);
    expect(stored).toHaveLength(2);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '5.4400', hold: '34.5600' });
    // The refused items left nothing behind: no event, no hold line, no outbox row.
    const orderIds = stored.map((row) => row.id);
    for (const id of orderIds) expect(await ledgerOf(db, id)).toHaveLength(1);
    expect(
      await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'order.dispatch_requested')),
    ).toHaveLength(2);
  });

  it('answers a changed price and a duplicate inside the item, with their figures', async () => {
    const { db } = await testDb();
    await v1.get('/v1/services');
    await db.update(s.services).set({ basePrice: '25.0000' }).where(eq(s.services.id, world.auto.serviceId));
    const first = body(await place(world.manual.serviceId, IMEIS[0]));
    const res = await v1.post('/v1/orders/bulk', {
      orders: [
        { serviceId: world.auto.serviceId, imei: IMEIS[1] },
        { serviceId: world.manual.serviceId, imei: IMEIS[0] },
      ],
    });
    const results = body(res).results;
    expect(results[0].error).toMatchObject({ code: 'PRICE_CHANGED', listedPrice: '17.2800', currentPrice: '25.0000' });
    expect(results[1].error).toMatchObject({ code: 'DUPLICATE_ORDER', orderId: first.id });
  });

  it('refuses a request with no orders, more than 100, or a malformed item, as a whole', async () => {
    expect((await v1.post('/v1/orders/bulk', { orders: [] })).statusCode).toBe(422);
    const many = Array.from({ length: 101 }, () => ({ serviceId: world.auto.serviceId, imei: IMEIS[0] }));
    expect((await v1.post('/v1/orders/bulk', { orders: many })).statusCode).toBe(422);
    const malformed = await v1.post('/v1/orders/bulk', { orders: [{ imei: IMEIS[0] }] });
    expect(malformed.statusCode).toBe(422);
    expect(body(malformed).errors[0].field).toBe('orders.0.serviceId');
    const { db } = await testDb();
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });
});

describe('GET /v1/orders and GET /v1/orders/:id', () => {
  async function fiveOrders(): Promise<number[]> {
    const ids: number[] = [];
    for (const imei of IMEIS.slice(0, 5)) {
      const res = await v1.post('/v1/orders', { serviceId: world.manual.serviceId, imei });
      ids.push(body(res).id);
      clock.advance(1000);
    }
    return ids;
  }

  it('lists the merchant orders newest first by cursor, never another merchant orders', async () => {
    const { db } = await testDb();
    const ids = await fiveOrders();
    const rich = await credentialsFor(t, db, world.other.id);
    await place(world.manual.serviceId, IMEIS[0], {}, v1Client(t, rich.key));
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await v1.get(`/v1/orders?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const page = body(res);
      seen.push(...page.data.map((order: { id: number }) => order.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    const all = body(await v1.get('/v1/orders'));
    expect(all.data).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
  });

  it('filters by status, ids, imei and updatedSince, and refuses a filter it does not know', async () => {
    const ids = await fiveOrders();
    await move(ids[0]!, { kind: 'accept' });
    await move(ids[1]!, { kind: 'reply' }, 'Code 1234');
    const ofStatus = async (status: string) =>
      body(await v1.get(`/v1/orders?status=${status}`)).data.map((order: { id: number }) => order.id);
    expect(await ofStatus('processing')).toEqual([ids[0]!]);
    expect(await ofStatus('completed')).toEqual([ids[1]!]);
    expect((await ofStatus('pending,processing')).sort()).toEqual([ids[0]!, ids[2]!, ids[3]!, ids[4]!].sort());
    expect(
      body(await v1.get(`/v1/orders?ids=${ids[2]},${ids[3]},999999`)).data.map((order: { id: number }) => order.id),
    ).toEqual([ids[3]!, ids[2]!]);
    expect(body(await v1.get(`/v1/orders?imei=${IMEIS[4]}`)).data.map((order: { id: number }) => order.id)).toEqual([
      ids[4]!,
    ]);
    // Orders changed at or after a time: two orders last changed in January, three in June.
    const { db } = await testDb();
    for (const [index, id] of ids.entries()) {
      await db
        .update(s.orders)
        .set({ updatedAt: new Date(index < 2 ? '2026-01-10T00:00:00Z' : '2026-06-10T00:00:00Z') })
        .where(eq(s.orders.id, id));
    }
    const since = async (time: string) =>
      body(await v1.get(`/v1/orders?updatedSince=${encodeURIComponent(time)}`)).data.map(
        (order: { id: number }) => order.id,
      );
    expect((await since('2026-03-01T00:00:00Z')).sort()).toEqual([ids[2]!, ids[3]!, ids[4]!].sort());
    expect(await since('2999-01-01T00:00:00Z')).toEqual([]);
    expect(await since('2026-01-10T00:00:00.000+00:00')).toHaveLength(5);
    for (const query of ['status=lost', 'ids=abc', 'updatedSince=yesterday', 'limit=1000']) {
      expect((await v1.get(`/v1/orders?${query}`)).statusCode, query).toBe(422);
    }
  });

  it('shows one order with its status and result, and says 404 for an unknown id and for another merchant order', async () => {
    const { db } = await testDb();
    const placed = body(await place(world.auto.serviceId));
    expect(body(await v1.get(`/v1/orders/${placed.id}`))).toMatchObject({ id: placed.id, status: 'pending' });
    await move(placed.id, { kind: 'reply' }, 'Unlocked: code 8842');
    expect(body(await v1.get(`/v1/orders/${placed.id}`))).toMatchObject({
      status: 'completed',
      result: { code: 'Unlocked: code 8842' },
      completedAt: expect.any(String),
    });
    const rejected = body(await place(world.auto.serviceId, IMEIS[1]));
    await move(rejected.id, { kind: 'reject' }, 'Carrier refused');
    expect(body(await v1.get(`/v1/orders/${rejected.id}`))).toMatchObject({
      status: 'rejected',
      result: { code: 'Carrier refused' },
    });
    expect((await v1.get('/v1/orders/999999')).statusCode).toBe(404);
    const other = await credentialsFor(t, db, world.other.id);
    const foreign = await v1Client(t, other.key).get(`/v1/orders/${placed.id}`);
    expect(foreign.statusCode).toBe(404);
    expect(body(foreign).code).toBe('NOT_FOUND');
  });
});

describe('POST /v1/orders/:id/cancel and POST /v1/orders/:id/verify', () => {
  it('cancels an order that was never sent when the service allows it: rejected, the hold released, the order in the answer', async () => {
    const { db } = await testDb();
    await db.update(s.services).set({ allowCancel: true }).where(eq(s.services.id, world.manual.serviceId));
    const placed = body(await place(world.manual.serviceId));
    expect(placed.canCancel).toBe(true);
    const res = await v1.post(`/v1/orders/${placed.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      id: placed.id,
      status: 'rejected',
      result: { code: 'Cancelled by the merchant' },
      canCancel: false,
    });
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect((await ledgerOf(db, placed.id)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_release']);
    expect(body(await v1.post(`/v1/orders/${placed.id}/cancel`)).code).toBe('ORDER_NOT_OPEN');
  });

  it('refuses a service that does not allow it, an order already sent, another merchant order and an unknown id', async () => {
    const { db } = await testDb();
    const plain = body(await place(world.manual.serviceId));
    const refused = await v1.post(`/v1/orders/${plain.id}/cancel`);
    expect(refused.statusCode).toBe(409);
    expect(body(refused)).toMatchObject({
      code: 'INVALID_TRANSITION',
      detail: 'This service does not allow cancellation.',
    });
    await db.update(s.services).set({ allowCancel: true }).where(eq(s.services.id, world.auto.serviceId));
    const sent = body(await place(world.auto.serviceId));
    await db.update(s.orders).set({ status: 'processing', dispatchState: 'sent' }).where(eq(s.orders.id, sent.id));
    const late = await v1.post(`/v1/orders/${sent.id}/cancel`);
    expect(late.statusCode).toBe(409);
    expect(body(late).code).toBe('ALREADY_SENT');
    const other = await credentialsFor(t, db, world.other.id);
    expect((await v1Client(t, other.key).post(`/v1/orders/${plain.id}/cancel`)).statusCode).toBe(404);
    expect((await v1.post('/v1/orders/999999/cancel')).statusCode).toBe(404);
  });

  it('asks for the verification of a completed order once, inside the window, and refuses it otherwise', async () => {
    const { db } = await testDb();
    await db
      .update(s.services)
      .set({ allowVerify: true, verifyWindowH: 24 })
      .where(eq(s.services.id, world.auto.serviceId));
    const early = body(await place(world.auto.serviceId, IMEIS[0]));
    const notYet = await v1.post(`/v1/orders/${early.id}/verify`);
    expect(notYet.statusCode).toBe(409);
    expect(body(notYet).code).toBe('ORDER_NOT_COMPLETED');

    await move(early.id, { kind: 'reply' }, 'Unlocked');
    expect(body(await v1.get(`/v1/orders/${early.id}`)).canVerify).toBe(true);
    const res = await v1.post(`/v1/orders/${early.id}/verify`);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      id: early.id,
      status: 'completed',
      verificationStatus: 'requested',
      canVerify: false,
    });
    expect(body(await v1.post(`/v1/orders/${early.id}/verify`)).code).toBe('INVALID_TRANSITION');

    const late = body(await place(world.auto.serviceId, IMEIS[1]));
    await move(late.id, { kind: 'reply' }, 'Unlocked');
    clock.advance(25 * HOUR);
    const tooLate = await v1.post(`/v1/orders/${late.id}/verify`);
    expect(tooLate.statusCode).toBe(409);
    expect(body(tooLate).detail).toBe('The verification window of this service has passed.');

    const notAllowed = body(await place(world.manual.serviceId, IMEIS[2]));
    await move(notAllowed.id, { kind: 'reply' }, 'Done');
    const refused = await v1.post(`/v1/orders/${notAllowed.id}/verify`);
    expect(body(refused)).toMatchObject({
      code: 'INVALID_TRANSITION',
      detail: 'This service does not allow verification.',
    });
  });

  it('needs the orders:write scope to cancel or verify, and orders:read to read', async () => {
    const { db } = await testDb();
    const placed = body(await place(world.manual.serviceId));
    const readOnly = await credentialsFor(t, db, world.merchant.id, { scopes: ['orders:read'] });
    const client = v1Client(t, readOnly.key);
    expect((await client.get(`/v1/orders/${placed.id}`)).statusCode).toBe(200);
    expect((await client.post(`/v1/orders/${placed.id}/cancel`)).statusCode).toBe(403);
    expect((await client.post(`/v1/orders/${placed.id}/verify`)).statusCode).toBe(403);
    const writeOnly = await credentialsFor(t, db, world.merchant.id, { scopes: ['orders:write'] });
    expect((await v1Client(t, writeOnly.key).get(`/v1/orders/${placed.id}`)).statusCode).toBe(403);
  });
});
