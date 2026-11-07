// Integration tests of the Idempotency-Key of REST v1 (feature 7a, ALIGNMENT § 7): the first answer is stored with the key inside the
// placement's own transaction and replayed; another body is 409 IDEMPOTENCY_KEY_REUSED, a request still running 409 IDEMPOTENCY_IN_PROGRESS.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type MachineCredentials, body, clearApiKeyCaches, credentialsFor, v1Client } from '../support/machine-orders';
import { IMEIS, type OrdersWorld, ledgerOf, ordersWorld, outboxOf, walletOf } from '../support/orders';

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

/** Selects the wallet account of a merchant (not its hold account). */
const walletAccountOf = (clientId: number) =>
  and(
    eq(s.ledgerAccounts.ownerType, 'client'),
    eq(s.ledgerAccounts.ownerId, clientId),
    eq(s.ledgerAccounts.kind, 'client_wallet'),
  );

/** Places one order under a key. */
const place = (key: string | undefined, payload: Record<string, unknown> = {}, client = v1) =>
  client.post(
    '/v1/orders',
    { serviceId: world.auto.serviceId, imei: IMEIS[0], ...payload },
    key === undefined ? {} : { 'idempotency-key': key },
  );

/** Places a bulk under a key. */
const bulk = (key: string | undefined, orders: Array<Record<string, unknown>>, client = v1) =>
  client.post('/v1/orders/bulk', { orders }, key === undefined ? {} : { 'idempotency-key': key });

describe('POST /v1/orders with an Idempotency-Key', () => {
  it('stores the first answer and replays it for the same request: one order, one hold, the same body', async () => {
    const { db } = await testDb();
    const first = await place('retry-1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const again = await place('retry-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(body(again)).toEqual(body(first));
    const orders = await db.select().from(s.orders);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: body(first).id, idempotencyKey: 'retry-1', source: 'v1' });
    expect(await ledgerOf(db, orders[0]!.id)).toHaveLength(1);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', orders[0]!.id)).toHaveLength(1);
    const [stored] = await db.select().from(s.idempotencyKeys);
    expect(stored).toMatchObject({ clientId: world.merchant.id, key: 'retry-1', scope: 'order', status: 201 });
    expect(stored!.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads two spellings of one body as the same request, and another body with the key as 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { db } = await testDb();
    await v1.post('/v1/orders', { imei: IMEIS[0], serviceId: world.auto.serviceId }, { 'idempotency-key': 'spelling' });
    const reordered = await place('spelling');
    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers['idempotency-replayed']).toBe('true');
    const different = await place('spelling', { imei: IMEIS[1] });
    expect(different.statusCode).toBe(409);
    expect(body(different)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const otherService = await place('spelling', { serviceId: world.manual.serviceId });
    expect(otherService.statusCode).toBe(409);
    expect(await db.select().from(s.orders)).toHaveLength(1);
  });

  it('is 409 IDEMPOTENCY_KEY_REUSED on the other route: a key stands for one request, order or bulk', async () => {
    const { db } = await testDb();
    expect((await place('shared')).statusCode).toBe(201);
    const asBulk = await bulk('shared', [{ serviceId: world.auto.serviceId, imei: IMEIS[0] }]);
    expect(asBulk.statusCode).toBe(409);
    expect(body(asBulk).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await bulk('shared-bulk', [{ serviceId: world.auto.serviceId, imei: IMEIS[1] }])).statusCode).toBe(200);
    expect((await place('shared-bulk', { imei: IMEIS[1] })).statusCode).toBe(409);
    expect(await db.select().from(s.orders)).toHaveLength(2);
  });

  it('replays the stored answer whatever happened since: the wallet is empty, the service is off, the order is done', async () => {
    const { db } = await testDb();
    const first = body(await place('stored'));
    await db.update(s.ledgerAccounts).set({ balance: '0.0000' }).where(walletAccountOf(world.merchant.id));
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.auto.serviceId));
    await db.update(s.orders).set({ status: 'completed', resultCode: 'Done' }).where(eq(s.orders.id, first.id));
    const replay = await place('stored');
    expect(replay.statusCode).toBe(201);
    expect(body(replay)).toEqual(first);
    expect(body(replay).status).toBe('pending');
    expect(await db.select().from(s.orders)).toHaveLength(1);
  });

  it('stores nothing for a refusal, so the same key may be tried again: an invalid IMEI, then a balance that was too low', async () => {
    const { db } = await testDb();
    const invalid = await place('again', { imei: '123456789012345' });
    expect(invalid.statusCode).toBe(422);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
    expect((await place('again')).statusCode).toBe(201);
    await db.update(s.ledgerAccounts).set({ balance: '1.0000' }).where(walletAccountOf(world.other.id));
    const poor = await credentialsFor(t, db, world.other.id);
    const client = v1Client(t, poor.key);
    expect((await place('funds', { imei: IMEIS[2] }, client)).statusCode).toBe(402);
    expect(await db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.key, 'funds'))).toHaveLength(0);
  });

  it('keeps keys apart per merchant, and places every request without a key as its own order', async () => {
    const { db } = await testDb();
    const other = await credentialsFor(t, db, world.other.id);
    const mine = body(await place('same-key'));
    const theirs = await place('same-key', {}, v1Client(t, other.key));
    expect(theirs.statusCode).toBe(201);
    expect(theirs.headers['idempotency-replayed']).toBeUndefined();
    expect(body(theirs).id).not.toBe(mine.id);
    expect((await place(undefined, { imei: IMEIS[3] })).statusCode).toBe(201);
    expect((await place(undefined, { imei: IMEIS[3] })).statusCode).toBe(409);
  });

  it('refuses a key that is empty, too long or has spaces', async () => {
    for (const key of ['', 'a'.repeat(256), 'has space', 'tab\there']) {
      const res = await place(key);
      expect(res.statusCode, JSON.stringify(key)).toBe(422);
    }
    const { db } = await testDb();
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect((await place('a'.repeat(255))).statusCode).toBe(201);
  });

  it('answers 409 IDEMPOTENCY_IN_PROGRESS while another request holds the key, and works once it is free', async () => {
    const { pool } = await testDb();
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `idempotency:${world.merchant.id}:busy`,
      ]);
      const refused = await place('busy');
      expect(refused.statusCode).toBe(409);
      expect(body(refused).code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(refused.headers['retry-after']).toBe('1');
      const { db } = await testDb();
      expect(await db.select().from(s.orders)).toHaveLength(0);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect((await place('busy')).statusCode).toBe(201);
  });

  it('posts once when the same request arrives many times at once: one order, one hold, every answer the same order', async () => {
    const { db } = await testDb();
    const answers = await Promise.all(Array.from({ length: 8 }, () => place('race')));
    const codes = answers.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of answers.filter((answer) => answer.statusCode !== 201)) {
      expect(res.statusCode).toBe(409);
      expect(body(res).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    const ids = new Set(answers.filter((res) => res.statusCode === 201).map((res) => body(res).id));
    expect(ids.size).toBe(1);
    expect(await db.select().from(s.orders)).toHaveLength(1);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
    // A retry after the race replays.
    const late = await place('race');
    expect(late.statusCode).toBe(201);
    expect(late.headers['idempotency-replayed']).toBe('true');
    expect(body(late).id).toBe([...ids][0]);
  });

  it('never spends twice for different keys on a wallet that holds three orders: parallel keys, no overspend', async () => {
    const { db } = await testDb();
    await db.update(s.ledgerAccounts).set({ balance: '52.0000' }).where(walletAccountOf(world.merchant.id));
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const answers = await Promise.all(keys.map((key, index) => place(key, { imei: IMEIS[index] })));
    expect(answers.filter((res) => res.statusCode === 201)).toHaveLength(3);
    expect(answers.filter((res) => res.statusCode === 402)).toHaveLength(2);
    expect(await db.select().from(s.orders)).toHaveLength(3);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(3);
  });
});

describe('POST /v1/orders/bulk with an Idempotency-Key', () => {
  const items = () => [
    { serviceId: world.auto.serviceId, imei: IMEIS[0] },
    { serviceId: world.auto.serviceId, imei: '123456789012345' },
    { serviceId: world.manual.serviceId, imei: IMEIS[1] },
  ];

  it('stores the whole answer, refusals included, and replays it: the orders and the hold are posted once', async () => {
    const { db } = await testDb();
    const first = await bulk('bulk-1', items());
    expect(first.statusCode).toBe(200);
    expect(body(first).results.map((result: { ok: boolean }) => result.ok)).toEqual([true, false, true]);
    const again = await bulk('bulk-1', items());
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(body(again)).toEqual(body(first));
    expect(await db.select().from(s.orders)).toHaveLength(2);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '77.7200', hold: '22.2800' });
    const [stored] = await db.select().from(s.idempotencyKeys);
    expect(stored).toMatchObject({ key: 'bulk-1', scope: 'bulk', status: 200 });
    // Another list under the key is another request.
    const other = await bulk('bulk-1', items().slice(0, 1));
    expect(other.statusCode).toBe(409);
    expect(body(other).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('posts once when the same bulk arrives many times at once', async () => {
    const { db } = await testDb();
    const answers = await Promise.all(Array.from({ length: 5 }, () => bulk('bulk-race', items())));
    const done = answers.filter((res) => res.statusCode === 200);
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const res of answers.filter((answer) => answer.statusCode !== 200))
      expect(body(res).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(new Set(done.map((res) => JSON.stringify(body(res)))).size).toBe(1);
    expect(await db.select().from(s.orders)).toHaveLength(2);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '77.7200', hold: '22.2800' });
  });
});
