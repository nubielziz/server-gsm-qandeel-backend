// Integration tests of placing orders through the merchant portal (feature 5): POST /client/orders on the real application: the price
// from the one resolver, the hold in the ledger, the placement dispatch rule and its outbox row, the price guard (user rule 9), the
// duplicate rule, bulk orders, the refusals (funds, IMEI, service, pending merchant) and the concurrency rule (no overspend).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { ListedPrices } from '../../src/modules/catalog';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, fundWallet, insertWalletMerchant, ledgerTotals } from '../support/money';
import {
  IMEIS,
  eventsOf,
  json,
  ledgerOf,
  type OrdersWorld,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
  walletOf,
} from '../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('POST /client/orders: one automatic order', () => {
  it('prices the order, holds the price, writes its first events and the dispatch row, and answers at once', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const res = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: ' 352905112490861 ' });
    expect(res.statusCode).toBe(201);
    const [placed] = json(res).orders;
    expect(placed).toMatchObject({
      status: 'pending',
      imei: '352905112490861',
      quantity: 1,
      unitPrice: '17.2800',
      totalPrice: '17.2800',
      currency: 'USD',
      service: { id: auto.serviceId, name: 'AT&T USA Premier Unlock', type: 'imei' },
      source: 'portal',
      result: { code: null, comment: null, fileId: null },
      verificationStatus: null,
      canCancel: false,
      canVerify: false,
      completedAt: null,
    });
    // Nothing the merchant may not see.
    expect(Object.keys(placed)).not.toContain('unitCost');
    expect(Object.keys(placed)).not.toContain('supplier');

    const row = await orderRow(db, placed.id);
    expect(row).toMatchObject({
      clientId: merchant.id,
      status: 'pending',
      dispatchState: 'pending',
      unitCost: '13.5000',
      totalCost: '13.5000',
      type: 'imei',
      source: 'portal',
    });
    // placed_at and created_at are the same instant, from the injected clock (decisions 025 and 031).
    expect(row.placedAt.getTime()).toBe(row.createdAt.getTime());
    expect(row.pricingSnapshot).toMatchObject({ source: 'base', price: '17.2800', floor: '14.3100', clamped: false });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The ledger: wallet to hold, once, under the deterministic key.
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await ledgerOf(db, row.id)).toEqual([{ kind: 'order_hold', key: `order:${row.id}:hold` }]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    expect((await eventsOf(db, row.id)).map((event) => [event.type, event.actorType])).toEqual([
      ['created', 'client'],
      ['hold', 'system'],
    ]);
    // The dispatch job of feature 6 will find this row; no status changed, so no webhook row.
    const dispatch = await outboxOf(db, 'order.dispatch_requested', row.id);
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.payload).toMatchObject({ orderId: row.id });
    expect(await outboxOf(db, 'order.status_changed', row.id)).toHaveLength(0);
  });

  it('puts a manual service in the manual queue with the reason, and writes no dispatch row', async () => {
    const { db, merchant, manual } = world;
    const portal = await portalFor(t, merchant.id);
    const res = await portal.post('/client/orders', { serviceId: manual.serviceId, imei: IMEIS[1] });
    expect(res.statusCode).toBe(201);
    const id = json(res).orders[0].id as number;
    expect(await orderRow(db, id)).toMatchObject({ status: 'pending', dispatchState: 'manual' });
    const events = await eventsOf(db, id);
    expect(events.map((event) => event.type)).toEqual(['created', 'hold', 'review']);
    expect(events[2]!.data).toMatchObject({ reason: 'Manual service: operator dispatch required' });
    expect(await outboxOf(db, 'order.dispatch_requested', id)).toHaveLength(0);
  });

  it('puts a service without an active supplier link in the manual queue too', async () => {
    const { db, merchant, auto } = world;
    await db
      .update(s.serviceSupplierLinks)
      .set({ isActive: false })
      .where(eq(s.serviceSupplierLinks.serviceId, auto.serviceId));
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[2] });
    expect(res.statusCode).toBe(201);
    expect(await orderRow(db, json(res).orders[0].id)).toMatchObject({ dispatchState: 'manual' });
  });

  it("stores the main input of a server service as the first required field's value and keeps the field values", async () => {
    const { db, merchant, server } = world;
    const portal = await portalFor(t, merchant.id);
    const res = await portal.post('/client/orders', {
      serviceId: server.serviceId,
      inputs: { username: 'amir92@gsm.example' },
    });
    expect(res.statusCode).toBe(201);
    const row = await orderRow(db, json(res).orders[0].id);
    expect(row).toMatchObject({
      imei: 'amir92@gsm.example',
      type: 'server',
      inputs: { username: 'amir92@gsm.example' },
    });
  });

  it('multiplies the price by the quantity of a pack and checks the quantity against the service', async () => {
    const { db, merchant, auto } = world;
    await db.update(s.services).set({ minQty: 1, maxQty: 5 }).where(eq(s.services.id, auto.serviceId));
    const portal = await portalFor(t, merchant.id);
    const res = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0], quantity: 3 });
    // 3 x 17.28 = 51.84 is above the 10 % tolerance only if listed; nothing was listed, so it is charged.
    expect(res.statusCode).toBe(201);
    expect(json(res).orders[0]).toMatchObject({ quantity: 3, unitPrice: '17.2800', totalPrice: '51.8400' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '48.1600', hold: '51.8400' });

    const tooMany = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1], quantity: 6 });
    expect(tooMany.statusCode).toBe(422);
    expect(json(tooMany).errors).toEqual([expect.objectContaining({ field: 'quantity' })]);

    await db
      .update(s.services)
      .set({ qtyOptions: [10, 20] })
      .where(eq(s.services.id, auto.serviceId));
    const notAPack = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1], quantity: 3 });
    expect(notAPack.statusCode).toBe(422);
    expect(json(notAPack).errors[0].message).toContain('10, 20');
  });
});

describe('POST /client/orders: refusals', () => {
  it('refuses an invalid IMEI with INVALID_IMEI on the field, and a missing one with VALIDATION_FAILED', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const bad = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: '352905112490860' });
    expect(bad.statusCode).toBe(422);
    expect(json(bad)).toMatchObject({ code: 'INVALID_IMEI', errors: [{ field: 'imei', code: 'invalid_imei' }] });
    const short = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: '1234' });
    expect(json(short).code).toBe('INVALID_IMEI');
    const none = await portal.post('/client/orders', { serviceId: auto.serviceId });
    expect(none.statusCode).toBe(422);
    expect(json(none)).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'imei', code: 'required' }] });
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
  });

  it('refuses a missing required field of a server service on `inputs.username`', async () => {
    const { merchant, server } = world;
    const res = await (await portalFor(t, merchant.id)).post('/client/orders', { serviceId: server.serviceId });
    expect(res.statusCode).toBe(422);
    expect(json(res).errors).toEqual([expect.objectContaining({ field: 'inputs.username', code: 'required' })]);
    const unknown = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', {
      serviceId: server.serviceId,
      inputs: { username: 'a', colour: 'red' },
    });
    expect(json(unknown).errors).toEqual([expect.objectContaining({ field: 'inputs.colour', code: 'unknown_field' })]);
  });

  it('refuses an unknown, archived or disabled service, and a body with both imei and imeis', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const unknown = await portal.post('/client/orders', { serviceId: 999999, imei: IMEIS[0] });
    expect(unknown.statusCode).toBe(404);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, auto.serviceId));
    const disabled = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(disabled.statusCode).toBe(409);
    expect(json(disabled).code).toBe('SERVICE_DISABLED');
    await db.update(s.services).set({ archivedAt: new Date() }).where(eq(s.services.id, auto.serviceId));
    const archived = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(archived.statusCode).toBe(404);
    const both = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0], imeis: [IMEIS[1]] });
    expect(both.statusCode).toBe(422);
    expect(json(both).errors[0].field).toBe('imeis');
  });

  it('hides a service from a group the category does not allow', async () => {
    const { db, merchant, auto } = world;
    await db
      .update(s.serviceCategories)
      .set({ allowedGroupIds: [987654] })
      .where(eq(s.serviceCategories.id, auto.categoryId));
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(res.statusCode).toBe(404);
  });

  it('answers 402 INSUFFICIENT_FUNDS and leaves no order, no hold and no event behind', async () => {
    const { db, auto } = world;
    const poor = await insertWalletMerchant(db, { name: 'Poor' });
    await fundWallet(db, poor.id, '10');
    const res = await (
      await portalFor(t, poor.id)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(res.statusCode).toBe(402);
    expect(json(res).code).toBe('INSUFFICIENT_FUNDS');
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await db.select().from(s.orderEvents)).toHaveLength(0);
    expect(await walletOf(db, poor.id)).toEqual({ wallet: '10.0000', hold: '0.0000' });
  });

  it('lets a merchant with a credit limit order beyond its balance, down to the limit (user rule 2)', async () => {
    const { db, auto } = world;
    const credit = await insertWalletMerchant(db, { name: 'Credit', creditLimit: '30' });
    await fundWallet(db, credit.id, '10');
    const portal = await portalFor(t, credit.id);
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).statusCode).toBe(201);
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: credit.id }))?.balance).toBe('-7.2800');
    // 30 of credit allow -30: another 17.28 would end at -24.56, a third at -41.84.
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1] })).statusCode).toBe(201);
    const third = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[2] });
    expect(third.statusCode).toBe(402);
  });

  it('refuses a pending merchant (B153) and a call without a session', async () => {
    const { db, auto } = world;
    const pendingId = await insertMerchant(db, { status: 'pending' });
    const pending = await (
      await portalFor(t, pendingId)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(pending.statusCode).toBe(403);
    expect(json(pending).code).toBe('ACCOUNT_PENDING_APPROVAL');
    const anonymous = await t.app.inject({ method: 'POST', url: '/client/orders', payload: { serviceId: 1 } });
    expect(anonymous.statusCode).toBe(401);
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });
});

describe('POST /client/orders: the duplicate rule (catalog-2)', () => {
  it('refuses a second open order for the same service and IMEI, even typed with spaces, then allows it once the first is closed', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const first = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(first.statusCode).toBe(201);
    const again = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: '3529 0511-2490861' });
    expect(again.statusCode).toBe(409);
    expect(json(again)).toMatchObject({ code: 'DUPLICATE_ORDER', orderId: json(first).orders[0].id });
    expect(await db.select().from(s.orders)).toHaveLength(1);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });

    // Another merchant ordering the same IMEI is not a duplicate; neither is the same merchant on another service.
    const other = await (
      await portalFor(t, world.other.id)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(other.statusCode).toBe(201);

    await db
      .update(s.orders)
      .set({ status: 'rejected', dispatchState: 'done' })
      .where(eq(s.orders.id, json(first).orders[0].id));
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).statusCode).toBe(201);
  });

  it("does not refuse under the 'allow' rule", async () => {
    const { merchant, auto, db } = world;
    await db.update(s.services).set({ duplicateRule: 'allow' }).where(eq(s.services.id, auto.serviceId));
    const portal = await portalFor(t, merchant.id);
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).statusCode).toBe(201);
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).statusCode).toBe(201);
  });

  it('lets exactly one of two parallel identical placements through', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const results = await Promise.all(
      [1, 2, 3].map(() => portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[3] })),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await db.select().from(s.orders)).toHaveLength(1);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });
});

describe('POST /client/orders: the price guard (user rule 9)', () => {
  const list = (price: string) =>
    t.app
      .get(ListedPrices)
      .record(world.db, world.merchant.id, [{ serviceId: world.auto.serviceId, price: Money.of(price) }], clock.now());

  it('refuses an order more than the tolerance above the listed price with both prices, and charges nothing', async () => {
    await list('10.0000');
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toMatchObject({ code: 'PRICE_CHANGED', listedPrice: '10.0000', currentPrice: '17.2800' });
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(world.db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
  });

  it('charges a raise within the tolerance and records it in the pricing snapshot', async () => {
    await list('16.0000');
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(201);
    const row = await orderRow(world.db, json(res).orders[0].id);
    expect(row.totalPrice).toBe('17.2800');
    expect(row.pricingSnapshot).toMatchObject({ raised: true, raisedReason: 'price_change', listedPrice: '16.0000' });
  });

  it('charges the current price when it is not above the listed one, and when nothing was listed', async () => {
    await list('20.0000');
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(201);
    expect((await orderRow(world.db, json(res).orders[0].id)).pricingSnapshot).not.toHaveProperty('raised');
  });

  it('follows the tolerance setting', async () => {
    await world.db.insert(s.settings).values({ key: 'pricing.price_change_tolerance_percent', value: 0 });
    await list('16.0000');
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /client/orders: a bulk of IMEIs', () => {
  it('places one order per IMEI, all in one transaction, each with its own hold', async () => {
    const { db, merchant, auto } = world;
    const res = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', {
      serviceId: auto.serviceId,
      imeis: [IMEIS[0], IMEIS[1], IMEIS[2]],
    });
    expect(res.statusCode).toBe(201);
    const orders = json(res).orders as Array<{ id: number; imei: string }>;
    expect(orders.map((order) => order.imei)).toEqual([IMEIS[0], IMEIS[1], IMEIS[2]]);
    expect(new Set(orders.map((order) => order.id)).size).toBe(3);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '48.1600', hold: '51.8400' });
    for (const order of orders)
      expect(await ledgerOf(db, order.id)).toEqual([{ kind: 'order_hold', key: `order:${order.id}:hold` }]);
    expect(await outboxOf(db, 'order.dispatch_requested', orders[1]!.id)).toHaveLength(1);
  });

  it('places none when one IMEI is invalid, when one is a duplicate or when the wallet runs out on the last one', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const invalid = await portal.post('/client/orders', {
      serviceId: auto.serviceId,
      imeis: [IMEIS[0], '123', IMEIS[1]],
    });
    expect(invalid.statusCode).toBe(422);
    expect(json(invalid).errors[0].field).toBe('imeis.1');
    const duplicate = await portal.post('/client/orders', { serviceId: auto.serviceId, imeis: [IMEIS[0], IMEIS[0]] });
    expect(duplicate.statusCode).toBe(409);
    // 100 USD buy five at 17.28 (86.40): the sixth does not fit.
    const many = [...IMEIS, '490154203237518'];
    const broke = await portal.post('/client/orders', { serviceId: auto.serviceId, imeis: many });
    expect(broke.statusCode).toBe(402);
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('POST /client/orders: concurrency', () => {
  it('never overspends a wallet: parallel placements win or answer 402, and the ledger stays balanced', async () => {
    const { db, auto } = world;
    const limited = await insertWalletMerchant(db, { name: 'Limited' });
    await fundWallet(db, limited.id, '40');
    const portal = await portalFor(t, limited.id);
    const imeis = [IMEIS[0], IMEIS[1], IMEIS[2], IMEIS[3], IMEIS[4]];
    const results = await Promise.all(
      imeis.map((imei) => portal.post('/client/orders', { serviceId: auto.serviceId, imei })),
    );
    const codes = results.map((res) => res.statusCode).sort();
    // 40 / 17.28 = two orders.
    expect(codes).toEqual([201, 201, 402, 402, 402]);
    expect(await walletOf(db, limited.id)).toEqual({ wallet: '5.4400', hold: '34.5600' });
    expect(await db.select().from(s.orders).where(eq(s.orders.clientId, limited.id))).toHaveLength(2);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});
