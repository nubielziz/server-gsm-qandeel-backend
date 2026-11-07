// End-to-end walk of the map scenario `manual` (manual fulfilment by staff, docs/slices/orders.json), step by step through HTTP on the
// real application: the tables and statuses each step names are read back from Postgres. The steps share one story, so the tests of
// this file run in order and keep their state in the variables below.
// Steps 1, 2 and 10 are the merchant's Dhru calls (placeimeiorder, getimeiorder): feature 7a adds them to this file. Here the
// merchant places the same order through the portal, which uses the same placement path (steps 3 and 4 do not depend on the surface).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, ledgerTotals } from '../support/money';
import {
  IMEIS,
  auditOf,
  eventsOf,
  json,
  ledgerOf,
  type OrdersWorld,
  orderRow,
  ordersWorld,
  outboxOf,
  portalFor,
  systemBalance,
  walletOf,
} from '../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let orderId = 0;

beforeAll(async () => {
  t = await createTestApp({ clock });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*'], { name: 'Lina S.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('scenario manual: manual fulfilment by staff', () => {
  it("step 3: the price is the merchant's, then in one transaction: the order, its event, the hold entry and the outbox job", async () => {
    const { db, merchant, manual } = world;
    const portal = await portalFor(t, merchant.id);
    // The merchant sees its price on the catalog before ordering (the price protection memory of user rule 9).
    const catalog = json(await portal.get(`/client/services/${manual.serviceId}`));
    expect(catalog.price).toBe('5.0000');
    const res = await portal.post('/client/orders', { serviceId: manual.serviceId, imei: IMEIS[0] });
    expect(res.statusCode).toBe(201);
    orderId = json(res).orders[0].id;

    const row = await orderRow(db, orderId);
    expect(row).toMatchObject({
      clientId: merchant.id,
      serviceId: manual.serviceId,
      totalPrice: '5.0000',
      source: 'portal',
    });
    expect(row.pricingSnapshot).toMatchObject({ source: 'base', price: '5.0000' });
    expect((await eventsOf(db, orderId)).map((event) => event.type)).toEqual(['created', 'hold', 'review']);
    // The hold: wallet to hold, 5.00 ("طلب 5$": the balance is held and not spent yet).
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '95.0000', hold: '5.0000' });
    expect(await ledgerOf(db, orderId)).toEqual([{ kind: 'order_hold', key: `order:${orderId}:hold` }]);
    // The order was placed in the same transaction as its hold; the outbox row is the dispatch job of an automatic order: a manual
    // order needs none, so none is written, and no status changed yet.
    expect(await outboxOf(db, 'order.dispatch_requested', orderId)).toHaveLength(0);
    expect(await outboxOf(db, 'order.status_changed', orderId)).toHaveLength(0);
  });

  it('step 4: the answer is immediate: the order number (REFERENCEID) and status pending (STATUS 0)', async () => {
    const { merchant } = world;
    const shown = json(await (await portalFor(t, merchant.id)).get(`/client/orders/${orderId}`));
    expect(shown).toMatchObject({ id: orderId, status: 'pending', result: { code: null }, completedAt: null });
  });

  it('step 5: the service is manual, so the order shows in the staff queue with dispatch_state manual', async () => {
    const { db } = world;
    expect((await orderRow(db, orderId)).dispatchState).toBe('manual');
    const queue = await staff.get('/admin/orders?queue=manual');
    expect(queue.body.map((order: { id: number }) => order.id)).toEqual([orderId]);
    expect(queue.body[0]).toMatchObject({
      status: 'pending',
      queue: 'manual',
      dispatchState: 'manual',
      reviewReason: 'Manual service: operator dispatch required',
    });
  });

  it('step 6: accept moves the order to processing, no money moves, and the event is written', async () => {
    const { db, merchant } = world;
    clock.advance(2 * MINUTE);
    expect((await staff.post(`/admin/orders/${orderId}/accept`, {})).status).toBe(204);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'processing', dispatchState: 'operator' });
    expect((await eventsOf(db, orderId)).at(-1)).toMatchObject({ type: 'accepted', actorType: 'staff' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '95.0000', hold: '5.0000' });
    expect((await staff.get(`/admin/orders/${orderId}`)).body).toMatchObject({ status: 'processing', queue: null });
    expect((await outboxOf(db, 'order.status_changed', orderId))[0]!.payload).toMatchObject({
      fromStatus: 'pending',
      toStatus: 'processing',
    });
  });

  it('step 7: reply with the CODE after the work is done', async () => {
    clock.advance(10 * MINUTE);
    const res = await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked: code 8842 1113' });
    expect(res.status).toBe(204);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'completed',
      resultCode: 'Unlocked: code 8842 1113',
    });
  });

  it('step 8: completed, the hold becomes revenue (revenue only: no supplier cost) and every staff action is in audit_logs', async () => {
    const { db, merchant } = world;
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'completed', dispatchState: 'done' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '95.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('5.0000');
    expect(await systemBalance(db, 'cogs')).toBe('0.0000');
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['order_hold', 'order_settle']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The settlement's two entries: the hold is debited, revenue credited (Dr client_hold 5 / Cr revenue 5).
    const entries = await db
      .select({ amount: s.ledgerEntries.amount, kind: s.ledgerAccounts.kind })
      .from(s.ledgerEntries)
      .innerJoin(s.ledgerTransactions, eq(s.ledgerTransactions.id, s.ledgerEntries.transactionId))
      .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
      .where(and(eq(s.ledgerTransactions.idempotencyKey, `order:${orderId}:settle`)));
    expect(entries.map((entry) => [entry.kind, entry.amount]).sort()).toEqual([
      ['client_hold', '5.0000'],
      ['revenue', '-5.0000'],
    ]);
    const audit = await auditOf(db, orderId);
    expect(audit.map((row) => [row.action, row.actorName])).toEqual([
      ['accepted order', 'Lina S.'],
      ['completed order', 'Lina S.'],
    ]);
    expect(
      (await outboxOf(db, 'order.status_changed', orderId)).map(
        (row) => (row.payload as { toStatus: string }).toStatus,
      ),
    ).toEqual(['processing', 'completed']);
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id }))?.balance).toBe('95.0000');
  });

  // Step 10 (getimeiorder: STATUS 4 and CODE) is the Dhru call of feature 7a. Through the portal the merchant reads the same facts:
  it('step 10 (portal reading): the merchant reads the finished order with its result', async () => {
    const shown = json(await (await portalFor(t, world.merchant.id)).get(`/client/orders/${orderId}`));
    expect(shown).toMatchObject({ status: 'completed', result: { code: 'Unlocked: code 8842 1113' } });
    expect(shown.completedAt).not.toBeNull();
    expect(shown.events.map((event: { type: string }) => event.type)).toEqual([
      'created',
      'hold',
      'accepted',
      'completed',
    ]);
  });
});
