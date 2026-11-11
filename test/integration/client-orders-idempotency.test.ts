// Integration tests of the Idempotency-Key of the merchant portal's POST /client/orders (feature 24B, scope `portal`): the first answer is
// stored with the key in the placement's own transaction and replayed; another body is 409 IDEMPOTENCY_KEY_REUSED, a running one 409 IDEMPOTENCY_IN_PROGRESS.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { IDEMPOTENCY_WINDOW_DAYS } from '../../src/modules/orders';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, openSession } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { body, clearApiKeyCaches, credentialsFor, v1Client } from '../support/machine-orders';
import { IMEIS, type OrdersWorld, json, ledgerOf, ordersWorld, outboxOf, walletOf } from '../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let headers: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  world = await ordersWorld((await testDb()).db);
  headers = (await openSession(t, { type: 'client', id: world.merchant.id })).mutationHeaders;
});

/** Places through the portal, with the key when one is given. */
const place = (key: string | undefined, payload: Record<string, unknown> = {}, sent = headers) =>
  t.app.inject({
    method: 'POST',
    url: '/client/orders',
    headers: key === undefined ? sent : { ...sent, 'idempotency-key': key },
    payload: { serviceId: world.auto.serviceId, imei: IMEIS[0], ...payload } as never,
  });

const walletAccountOf = (clientId: number) =>
  and(
    eq(s.ledgerAccounts.ownerType, 'client'),
    eq(s.ledgerAccounts.ownerId, clientId),
    eq(s.ledgerAccounts.kind, 'client_wallet'),
  );

describe('POST /client/orders with an Idempotency-Key', () => {
  it('replays the first answer for the same request: one order, one hold, the same body, the replay header', async () => {
    const { db } = world;
    const first = await place('click-1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const again = await place('click-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual(json(first));
    const orders = await db.select().from(s.orders);
    expect(orders).toHaveLength(1);
    // The key is not written to the order: a bulk makes several, the idempotency_keys row alone guards the portal.
    expect(orders[0]).toMatchObject({ id: json(first).orders[0].id, idempotencyKey: null, source: 'portal' });
    expect(await ledgerOf(db, orders[0]!.id)).toHaveLength(1);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await outboxOf(db, 'order.dispatch_requested', orders[0]!.id)).toHaveLength(1);
    const [stored] = await db.select().from(s.idempotencyKeys);
    expect(stored).toMatchObject({ clientId: world.merchant.id, key: 'click-1', scope: 'portal', status: 201 });
    expect(stored!.response).toEqual(json(first));
  });

  it('replays a bulk of IMEIs as a whole: every order, held once', async () => {
    const { db } = world;
    const send = (key: string) => place(key, { imei: undefined, imeis: [IMEIS[0], IMEIS[1], IMEIS[2]] });
    const first = await send('bulk-1');
    expect(first.statusCode).toBe(201);
    expect(json(first).orders).toHaveLength(3);
    const again = await send('bulk-1');
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual(json(first));
    expect(await db.select().from(s.orders)).toHaveLength(3);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '48.1600', hold: '51.8400' });
  });

  it('reads two spellings of one body as the same request, and another body with the key as 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { db } = world;
    await t.app.inject({
      method: 'POST',
      url: '/client/orders',
      headers: { ...headers, 'idempotency-key': 'spelling' },
      payload: { imei: IMEIS[0], serviceId: world.auto.serviceId } as never,
    });
    const reordered = await place('spelling');
    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers['idempotency-replayed']).toBe('true');
    const different = await place('spelling', { imei: IMEIS[1] });
    expect(different.statusCode).toBe(409);
    expect(json(different).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await place('spelling', { serviceId: world.manual.serviceId })).statusCode).toBe(409);
    expect(await db.select().from(s.orders)).toHaveLength(1);
  });

  it('posts once when the same request arrives many times at once: one set of orders, one hold', async () => {
    const { db } = world;
    const answers = await Promise.all(Array.from({ length: 8 }, () => place('race')));
    expect(answers.filter((res) => res.statusCode === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of answers.filter((answer) => answer.statusCode !== 201)) {
      expect(res.statusCode).toBe(409);
      expect(json(res).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    const ids = new Set(answers.filter((res) => res.statusCode === 201).map((res) => json(res).orders[0].id));
    expect(ids.size).toBe(1);
    expect(await db.select().from(s.orders)).toHaveLength(1);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
  });

  it('answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After while another request holds the key', async () => {
    const { pool } = await testDb();
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `idempotency:${world.merchant.id}:busy`,
      ]);
      const refused = await place('busy');
      expect(refused.statusCode).toBe(409);
      expect(json(refused).code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(refused.headers['retry-after']).toBe('1');
      expect(await world.db.select().from(s.orders)).toHaveLength(0);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect((await place('busy')).statusCode).toBe(201);
  });

  it('keeps a key to one request kind: a key used on REST v1 is 409 on the portal, and the reverse', async () => {
    const { db } = world;
    const creds = await credentialsFor(t, db, world.merchant.id);
    const v1 = v1Client(t, creds.key);
    const viaV1 = await v1.post(
      '/v1/orders',
      { serviceId: world.auto.serviceId, imei: IMEIS[0] },
      { 'idempotency-key': 'from-v1' },
    );
    expect(viaV1.statusCode).toBe(201);
    const onPortal = await place('from-v1');
    expect(onPortal.statusCode).toBe(409);
    expect(json(onPortal).code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect((await place('from-portal', { imei: IMEIS[1] })).statusCode).toBe(201);
    const onV1 = await v1.post(
      '/v1/orders',
      { serviceId: world.auto.serviceId, imei: IMEIS[1] },
      { 'idempotency-key': 'from-portal' },
    );
    expect(onV1.statusCode).toBe(409);
    expect(body(onV1).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await db.select().from(s.orders)).toHaveLength(2);
  });

  it('stores nothing for a refusal: a 402 leaves no key, and the same key places once the wallet is topped up', async () => {
    const { db } = world;
    await db.update(s.ledgerAccounts).set({ balance: '1.0000' }).where(walletAccountOf(world.merchant.id));
    const poor = await place('funds');
    expect(poor.statusCode).toBe(402);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await db.select().from(s.orders)).toHaveLength(0);
    await db.update(s.ledgerAccounts).set({ balance: '100.0000' }).where(walletAccountOf(world.merchant.id));
    const placed = await place('funds');
    expect(placed.statusCode).toBe(201);
    expect(placed.headers['idempotency-replayed']).toBeUndefined();
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(1);
  });

  it('keeps keys apart per merchant', async () => {
    const otherHeaders = (await openSession(t, { type: 'client', id: world.other.id })).mutationHeaders;
    const mine = await place('same-key');
    const theirs = await place('same-key', {}, otherHeaders);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.headers['idempotency-replayed']).toBeUndefined();
    expect(json(theirs).orders[0].id).not.toBe(json(mine).orders[0].id);
  });

  it('works as before without the header: two requests with different inputs place two orders', async () => {
    const { db } = world;
    expect((await place(undefined)).statusCode).toBe(201);
    const second = await place(undefined, { imei: IMEIS[1] });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
    expect(await db.select().from(s.orders)).toHaveLength(2);
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
    // The duplicate rule still refuses the same open order.
    expect((await place(undefined)).statusCode).toBe(409);
  });

  it('forgets the answer after 7 days: the same key places again', async () => {
    const { db } = world;
    const first = await place('aging');
    expect(first.statusCode).toBe(201);
    await db.update(s.orders).set({ status: 'completed', dispatchState: 'done', resultCode: 'Done' });
    clock.advance(IDEMPOTENCY_WINDOW_DAYS * DAY - HOUR);
    expect((await place('aging')).headers['idempotency-replayed']).toBe('true');
    clock.advance(2 * HOUR);
    const old = await place('aging');
    expect(old.statusCode).toBe(201);
    expect(old.headers['idempotency-replayed']).toBeUndefined();
    expect(json(old).orders[0].id).not.toBe(json(first).orders[0].id);
    expect(await db.select().from(s.orders)).toHaveLength(2);
  });

  it('refuses a malformed key with 422 and places nothing', async () => {
    for (const key of ['', 'a'.repeat(256), 'has space', 'tab\there']) {
      const res = await place(key);
      expect(res.statusCode, JSON.stringify(key)).toBe(422);
    }
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
    expect((await place('a'.repeat(255))).statusCode).toBe(201);
  });

  it('leaves the guards as they were: a pending merchant is 403, a missing CSRF token is refused, nothing is stored', async () => {
    const { db } = world;
    const pendingId = await insertMerchant(db, { status: 'pending' });
    const pendingHeaders = (await openSession(t, { type: 'client', id: pendingId })).mutationHeaders;
    const pending = await place('pending', {}, pendingHeaders);
    expect(pending.statusCode).toBe(403);
    expect(json(pending).code).toBe('ACCOUNT_PENDING_APPROVAL');
    const noCsrf = await place('no-csrf', {}, { cookie: headers.cookie! });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).code).toBe('CSRF_FAILED');
    expect(await db.select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });
});
