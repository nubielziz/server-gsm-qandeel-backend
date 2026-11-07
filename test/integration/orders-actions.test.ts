// Integration tests of the staff order actions (feature 5, decision 025): accept, reply, reject, reopen, refund, the verification
// decision and the note, on the real application: the transition of status and dispatch state, the money in the ledger under its
// idempotency keys, the timeline, the outbox row, the audit row, every documented refusal, and the concurrency rule (a reply and a
// reject on one order post once).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MerchantSpend } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, ledgerTotals } from '../support/money';
import {
  IMEIS,
  auditOf,
  eventsOf,
  insertOrderRow,
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

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
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

/** Places an order through the portal and returns its id. */
async function place(serviceId: number, imei: string = IMEIS[0], clientId = world.merchant.id): Promise<number> {
  const res = await (await portalFor(t, clientId)).post('/client/orders', { serviceId, imei });
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** Marks the order as sent to a supplier that took it (the state feature 6's dispatch job will write). */
async function markSent(id: number): Promise<void> {
  await world.db
    .update(s.orders)
    .set({
      status: 'processing',
      dispatchState: 'sent',
      supplierId: world.auto.supplierId,
      supplierRef: 'NG-8841',
      sentAt: new Date(),
    })
    .where(eq(s.orders.id, id));
}

describe('POST /admin/orders/:id/accept', () => {
  it('moves a manual order to processing (operator), moves no money and writes the event, the outbox row and the audit row', async () => {
    const { db, merchant, manual } = world;
    const id = await place(manual.serviceId);
    const res = await staff.post(`/admin/orders/${id}/accept`, {});
    expect(res.status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({ status: 'processing', dispatchState: 'operator' });
    // The queue is derived: nothing waits for staff any more.
    const shown = await staff.get(`/admin/orders/${id}`);
    expect(shown.body).toMatchObject({
      status: 'processing',
      queue: null,
      reviewReason: null,
      dispatchState: 'operator',
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '95.0000', hold: '5.0000' });
    expect(await ledgerOf(db, id)).toHaveLength(1);

    const events = await eventsOf(db, id);
    expect(events.at(-1)).toMatchObject({
      type: 'accepted',
      fromStatus: 'pending',
      toStatus: 'processing',
      actorType: 'staff',
      actorId: staff.staffId,
    });
    const hooks = await outboxOf(db, 'order.status_changed', id);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.payload).toMatchObject({
      orderId: id,
      clientId: merchant.id,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    const [audit] = await auditOf(db, id);
    expect(audit).toMatchObject({
      action: 'accepted order',
      actorType: 'staff',
      actorId: staff.staffId,
      actorName: 'Lina S.',
    });
    expect(audit!.entityLabel).toBe(`ORD-${id} for Cairo GSM Lab`);
    expect(audit!.before).toMatchObject({ status: 'pending' });
    expect(audit!.after).toMatchObject({ status: 'processing' });
  });

  it('refuses an order that is not in the manual queue (NOT_MANUAL), a closed one and a held one', async () => {
    const { db, auto, manual } = world;
    const automatic = await place(auto.serviceId);
    const notManual = await staff.post(`/admin/orders/${automatic}/accept`, {});
    expect(notManual.status).toBe(409);
    expect(notManual.body).toMatchObject({ code: 'NOT_MANUAL' });

    const id = await place(manual.serviceId, IMEIS[1]);
    expect((await staff.post(`/admin/orders/${id}/accept`, {})).status).toBe(204);
    expect((await staff.post(`/admin/orders/${id}/accept`, {})).body).toMatchObject({ code: 'NOT_MANUAL' });

    await db.update(s.orders).set({ status: 'completed', dispatchState: 'done' }).where(eq(s.orders.id, id));
    expect((await staff.post(`/admin/orders/${id}/accept`, {})).body).toMatchObject({ code: 'ORDER_NOT_OPEN' });

    const held = await insertOrderRow(db, {
      clientId: world.merchant.id,
      serviceId: manual.serviceId,
      dispatchState: 'held',
    });
    expect((await staff.post(`/admin/orders/${held.id}/accept`, {})).body).toMatchObject({ code: 'ORDER_HELD' });
    expect((await staff.post('/admin/orders/999999/accept', {})).status).toBe(404);
  });
});

describe('POST /admin/orders/:id/reply', () => {
  it('completes the order and settles the hold to revenue: result, completion time, ledger, events, outbox and audit', async () => {
    const { db, merchant, auto } = world;
    const id = await place(auto.serviceId);
    clock.advance(5 * 60_000);
    const res = await staff.post(`/admin/orders/${id}/reply`, {
      code: 'Unlocked: code 8842 1113',
      comment: 'Wait 10 minutes.',
    });
    expect(res.status).toBe(204);
    const row = await orderRow(db, id);
    expect(row).toMatchObject({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'Unlocked: code 8842 1113',
      resultComment: 'Wait 10 minutes.',
    });
    expect(row.completedAt?.getTime()).toBe(clock.nowMs());

    // The hold became revenue; no supplier executed the order, so no cost line (map manual step 8).
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect(await systemBalance(db, 'cogs')).toBe('0.0000');
    expect(await ledgerOf(db, id)).toEqual([
      { kind: 'order_hold', key: `order:${id}:hold` },
      { kind: 'order_settle', key: `order:${id}:settle` },
    ]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const events = await eventsOf(db, id);
    expect(events.slice(2).map((event) => [event.type, event.actorType])).toEqual([
      ['completed', 'staff'],
      ['settle', 'system'],
    ]);
    expect(events[3]!.data).toMatchObject({ revenue: '17.2800', cost: '0.0000' });
    expect((await outboxOf(db, 'order.status_changed', id))[0]!.payload).toMatchObject({
      fromStatus: 'pending',
      toStatus: 'completed',
    });
    expect((await auditOf(db, id)).map((row) => row.action)).toEqual(['completed order']);
    // The merchant's own spend counts it (MerchantSpend reads the settlement).
    expect((await t.app.get(MerchantSpend).completedSpend(db, [merchant.id])).get(merchant.id)?.toWire()).toBe(
      '17.2800',
    );
  });

  it('books the supplier cost when a supplier executed the order', async () => {
    const { db, auto } = world;
    const id = await place(auto.serviceId);
    await markSent(id);
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done' })).status).toBe(204);
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect((await accountFigures(db, 'supplier_prepaid', { type: 'supplier', id: auto.supplierId }))?.balance).toBe(
      '-13.5000',
    );
    expect((await eventsOf(db, id)).find((event) => event.type === 'settle')!.data).toMatchObject({ cost: '13.5000' });
  });

  it('validates the body: a reply is required and the comment is at most 200 characters', async () => {
    const id = await place(world.auto.serviceId);
    const empty = await staff.post(`/admin/orders/${id}/reply`, { code: '   ' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'code' })]);
    const long = await staff.post(`/admin/orders/${id}/reply`, { code: 'ok', comment: 'x'.repeat(201) });
    expect(long.status).toBe(422);
    expect(long.body.errors).toEqual([expect.objectContaining({ field: 'comment' })]);
    expect((await orderRow(world.db, id)).status).toBe('pending');
  });

  it('refuses a closed order and a held order, and never posts the settlement twice', async () => {
    const { db, auto, merchant } = world;
    const id = await place(auto.serviceId);
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'a' })).status).toBe(204);
    const again = await staff.post(`/admin/orders/${id}/reply`, { code: 'b' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ORDER_NOT_OPEN' });
    expect((await orderRow(db, id)).resultCode).toBe('a');
    expect(await ledgerOf(db, id)).toHaveLength(2);
    const held = await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, dispatchState: 'held' });
    expect((await staff.post(`/admin/orders/${held.id}/reply`, { code: 'a' })).body).toMatchObject({
      code: 'ORDER_HELD',
    });
  });

  it('settles a free order without a posting', async () => {
    const { db, merchant, auto } = world;
    const free = await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      unitPrice: '0.0000',
      totalPrice: '0.0000',
      dispatchState: 'manual',
    });
    expect((await staff.post(`/admin/orders/${free.id}/reply`, { code: 'ok' })).status).toBe(204);
    expect(await ledgerOf(db, free.id)).toEqual([]);
    expect((await orderRow(db, free.id)).status).toBe('completed');
  });
});

describe('POST /admin/orders/:id/reject', () => {
  it('rejects with the reason, releases the hold to the wallet and writes rejected and release', async () => {
    const { db, merchant, auto } = world;
    const id = await place(auto.serviceId);
    const res = await staff.post(`/admin/orders/${id}/reject`, { reason: 'IMEI is blacklisted' });
    expect(res.status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'IMEI is blacklisted',
    });
    expect((await orderRow(db, id)).completedAt).not.toBeNull();
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect(await ledgerOf(db, id)).toEqual([
      { kind: 'order_hold', key: `order:${id}:hold` },
      { kind: 'order_release', key: `order:${id}:release` },
    ]);
    const events = await eventsOf(db, id);
    expect(events.slice(2).map((event) => event.type)).toEqual(['rejected', 'release']);
    expect(events[2]!.data).toMatchObject({ reason: 'IMEI is blacklisted' });
    expect((await outboxOf(db, 'order.status_changed', id))[0]!.payload).toMatchObject({ toStatus: 'rejected' });
    expect((await auditOf(db, id)).map((row) => row.action)).toEqual(['rejected order']);
  });

  it('refuses an empty reason and a second reject (ORDER_NOT_OPEN)', async () => {
    const id = await place(world.auto.serviceId);
    const empty = await staff.post(`/admin/orders/${id}/reject`, { reason: '' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect((await staff.post(`/admin/orders/${id}/reject`, { reason: 'No' })).status).toBe(204);
    expect((await staff.post(`/admin/orders/${id}/reject`, { reason: 'No' })).body).toMatchObject({
      code: 'ORDER_NOT_OPEN',
    });
  });

  it('rejects an order that a supplier has not finished (sent) and keeps the books balanced', async () => {
    const { db, merchant, auto } = world;
    const id = await place(auto.serviceId);
    await markSent(id);
    expect((await staff.post(`/admin/orders/${id}/reject`, { reason: 'Supplier could not do it' })).status).toBe(204);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('POST /admin/orders/:id/reopen and /refund', () => {
  async function completed(withSupplier = false): Promise<number> {
    const id = await place(world.auto.serviceId);
    if (withSupplier) await markSent(id);
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done' })).status).toBe(204);
    return id;
  }

  it('reopens a completed order: revenue goes back to the hold, the cost stays, a later reply settles again once', async () => {
    const { db, merchant } = world;
    const id = await completed(true);
    const settle = (await ledgerOf(db, id)).find((entry) => entry.kind === 'order_settle')!;
    expect(settle.key).toBe(`order:${id}:settle`);
    const res = await staff.post(`/admin/orders/${id}/reopen`, { reason: 'The code did not work' });
    expect(res.status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({
      status: 'processing',
      dispatchState: 'operator',
      completedAt: null,
      resultCode: null,
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    const ledger = await ledgerOf(db, id);
    const [settleTx] = await db
      .select({ id: s.ledgerTransactions.id })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, settle.key));
    expect(ledger.at(-1)).toEqual({ kind: 'adjustment', key: `reverse:${settleTx!.id}` });
    // The reversed settlement no longer counts as the merchant's spend (MerchantSpend reads the reversal key).
    expect((await t.app.get(MerchantSpend).completedSpend(db, [merchant.id])).get(merchant.id)?.toWire()).toBe(
      '0.0000',
    );
    const shown = await staff.get(`/admin/orders/${id}`);
    expect(shown.body).toMatchObject({ status: 'processing', queue: null, completedAt: null });
    expect((await eventsOf(db, id)).at(-1)).toMatchObject({
      type: 'reopened',
      fromStatus: 'completed',
      toStatus: 'processing',
    });
    expect((await outboxOf(db, 'order.status_changed', id)).at(-1)!.payload).toMatchObject({
      fromStatus: 'completed',
      toStatus: 'processing',
    });
    expect((await auditOf(db, id)).at(-1)!.action).toBe('reopened order');

    // Completing it again settles again under a numbered key and does not book the supplier cost a second time (B17).
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done again' })).status).toBe(204);
    expect((await ledgerOf(db, id)).at(-1)).toEqual({ kind: 'order_settle', key: `order:${id}:settle:2` });
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect((await t.app.get(MerchantSpend).completedSpend(db, [merchant.id])).get(merchant.id)?.toWire()).toBe(
      '17.2800',
    );
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('refuses to reopen an order that is not completed, and needs the orders:reopen permission', async () => {
    const open = await place(world.auto.serviceId, IMEIS[1]);
    const notCompleted = await staff.post(`/admin/orders/${open}/reopen`, {});
    expect(notCompleted.status).toBe(409);
    expect(notCompleted.body).toMatchObject({ code: 'ORDER_NOT_COMPLETED' });
    const id = await completed();
    const updater = await adminWith(t, ['orders:update', 'orders:read']);
    const denied = await updater.post(`/admin/orders/${id}/reopen`, {});
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await updater.post(`/admin/orders/${id}/refund`, { reason: 'x' })).status).toBe(403);
    expect((await orderRow(world.db, id)).status).toBe('completed');
  });

  it('refunds a completed order: the revenue goes straight back to the wallet, the cost is lost, once', async () => {
    const { db, merchant } = world;
    const id = await completed(true);
    const res = await staff.post(`/admin/orders/${id}/refund`, { reason: 'The merchant was charged twice' });
    expect(res.status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'The merchant was charged twice',
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect((await ledgerOf(db, id)).at(-1)!.kind).toBe('refund');
    expect((await ledgerOf(db, id)).at(-1)!.key).toMatch(/^reverse:\d+$/);
    expect((await eventsOf(db, id)).slice(-2).map((event) => event.type)).toEqual(['rejected', 'refund']);
    expect((await auditOf(db, id)).at(-1)!.action).toBe('refunded order');
    expect((await t.app.get(MerchantSpend).completedSpend(db, [merchant.id])).get(merchant.id)?.toWire()).toBe(
      '0.0000',
    );
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Final: neither a second refund nor a reopen is possible.
    expect((await staff.post(`/admin/orders/${id}/refund`, { reason: 'x' })).body).toMatchObject({
      code: 'ORDER_NOT_COMPLETED',
    });
    expect((await staff.post(`/admin/orders/${id}/reopen`, {})).status).toBe(409);
  });

  it('refuses a refund without a reason, of an open order, and of a storefront order (USE_REFUNDS)', async () => {
    const { db, auto } = world;
    const id = await completed();
    expect((await staff.post(`/admin/orders/${id}/refund`, { reason: ' ' })).status).toBe(422);
    const open = await place(auto.serviceId, IMEIS[2]);
    expect((await staff.post(`/admin/orders/${open}/refund`, { reason: 'x' })).body).toMatchObject({
      code: 'ORDER_NOT_COMPLETED',
    });
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'jack@example.com', name: 'Jack Turner' })
      .returning({ id: s.customers.id });
    const b2c = await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: auto.serviceId,
      status: 'completed',
      dispatchState: 'done',
    });
    const res = await staff.post(`/admin/orders/${b2c.id}/refund`, { reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'USE_REFUNDS' });
  });
});

describe('verification: POST /client/orders/:id/verify and POST /admin/orders/:id/verification', () => {
  async function verifiable(): Promise<number> {
    const { db, auto } = world;
    await db.update(s.services).set({ allowVerify: true, verifyWindowH: 24 }).where(eq(s.services.id, auto.serviceId));
    const id = await place(auto.serviceId);
    await markSent(id);
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done' })).status).toBe(204);
    return id;
  }

  it('moves a verification request through the queue and accepts it: the charge stands', async () => {
    const { db, merchant } = world;
    const id = await verifiable();
    const portal = await portalFor(t, merchant.id);
    expect((await portal.post(`/client/orders/${id}/verify`)).statusCode).toBe(204);
    const queued = await staff.get(`/admin/orders/${id}`);
    expect(queued.body).toMatchObject({
      status: 'completed',
      queue: 'verification',
      verificationStatus: 'requested',
      reviewReason: 'The merchant asked for the result to be checked',
    });
    expect((await staff.get('/admin/orders?queue=verification')).total).toBe(1);

    const res = await staff.post(`/admin/orders/${id}/verification`, { decision: 'accept', note: 'Result checked' });
    expect(res.status).toBe(204);
    const done = await staff.get(`/admin/orders/${id}`);
    expect(done.body).toMatchObject({
      status: 'completed',
      queue: null,
      verificationStatus: 'accepted',
      reviewReason: null,
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
    expect((await auditOf(db, id)).at(-1)!.action).toBe('accepted verification of');
    // No second decision.
    expect((await staff.post(`/admin/orders/${id}/verification`, { decision: 'accept' })).body).toMatchObject({
      code: 'NOT_IN_VERIFICATION',
    });
  });

  it('refunds on a refund decision: rejected, the revenue back to the wallet, the cost lost', async () => {
    const { db, merchant } = world;
    const id = await verifiable();
    await (await portalFor(t, merchant.id)).post(`/client/orders/${id}/verify`);
    const res = await staff.post(`/admin/orders/${id}/verification`, { decision: 'refund', note: 'Code did not work' });
    expect(res.status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({
      status: 'rejected',
      verificationStatus: 'refunded',
      resultCode: 'Code did not work',
    });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'cogs')).toBe('13.5000');
    expect((await eventsOf(db, id)).slice(-3).map((event) => event.type)).toEqual([
      'verification',
      'rejected',
      'refund',
    ]);
    expect((await outboxOf(db, 'order.status_changed', id)).at(-1)!.payload).toMatchObject({
      fromStatus: 'completed',
      toStatus: 'rejected',
    });
    expect((await auditOf(db, id)).at(-1)!.action).toBe('refunded after verification of');
  });

  it('refuses a decision on an order without a request, and a bad decision', async () => {
    const id = await verifiable();
    const none = await staff.post(`/admin/orders/${id}/verification`, { decision: 'accept' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: 'NOT_IN_VERIFICATION' });
    const bad = await staff.post(`/admin/orders/${id}/verification`, { decision: 'maybe' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ field: 'decision' })]);
  });

  it('lets the merchant ask once, inside the window, when the service allows it', async () => {
    const { db, merchant, auto } = world;
    const portal = await portalFor(t, merchant.id);
    const early = await place(auto.serviceId, IMEIS[1]);
    expect((await portal.post(`/client/orders/${early}/verify`)).statusCode).toBe(409);
    expect(json(await portal.post(`/client/orders/${early}/verify`)).code).toBe('ORDER_NOT_COMPLETED');

    const notAllowed = await place(auto.serviceId, IMEIS[2]);
    await staff.post(`/admin/orders/${notAllowed}/reply`, { code: 'ok' });
    const refused = await portal.post(`/client/orders/${notAllowed}/verify`);
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toMatchObject({
      code: 'INVALID_TRANSITION',
      detail: 'This service does not allow verification.',
    });

    await db.update(s.services).set({ allowVerify: true, verifyWindowH: 24 }).where(eq(s.services.id, auto.serviceId));
    expect((await portal.post(`/client/orders/${notAllowed}/verify`)).statusCode).toBe(204);
    expect(json(await portal.post(`/client/orders/${notAllowed}/verify`)).code).toBe('INVALID_TRANSITION');

    const late = await place(auto.serviceId, IMEIS[3]);
    await staff.post(`/admin/orders/${late}/reply`, { code: 'ok' });
    clock.advance(25 * HOUR);
    const tooLate = await portal.post(`/client/orders/${late}/verify`);
    expect(tooLate.statusCode).toBe(409);
    expect(json(tooLate).detail).toBe('The verification window of this service has passed.');
  });
});

describe('POST /admin/orders/:id/notes', () => {
  it('appends a note event, keeps the latest note on the order and never shows it to the merchant', async () => {
    const { db, merchant, auto } = world;
    const id = await place(auto.serviceId);
    expect((await staff.post(`/admin/orders/${id}/notes`, { body: 'Called the merchant.' })).status).toBe(204);
    expect((await staff.post(`/admin/orders/${id}/notes`, { body: 'He will resend the IMEI.' })).status).toBe(204);
    expect((await orderRow(db, id)).adminNote).toBe('He will resend the IMEI.');
    const events = await eventsOf(db, id);
    expect(events.filter((event) => event.type === 'note').map((event) => event.data)).toEqual([
      { body: 'Called the merchant.' },
      { body: 'He will resend the IMEI.' },
    ]);
    expect((await auditOf(db, id)).map((row) => row.action)).toEqual(['added a note to', 'added a note to']);
    const staffTimeline = await staff.get(`/admin/orders/${id}/events`);
    expect(staffTimeline.body.map((event: { type: string }) => event.type)).toContain('note');
    const shown = json(await (await portalFor(t, merchant.id)).get(`/client/orders/${id}`));
    expect(shown.events.map((event: { type: string }) => event.type)).not.toContain('note');
    expect(JSON.stringify(shown)).not.toContain('Called the merchant');
  });

  it('works on a closed order, refuses an empty note and an unknown order', async () => {
    const id = await place(world.auto.serviceId);
    await staff.post(`/admin/orders/${id}/reject`, { reason: 'No' });
    expect((await staff.post(`/admin/orders/${id}/notes`, { body: 'Late note' })).status).toBe(204);
    const empty = await staff.post(`/admin/orders/${id}/notes`, { body: '  ' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'body' })]);
    expect((await staff.post('/admin/orders/999999/notes', { body: 'x' })).status).toBe(404);
  });
});

describe('permissions and sessions', () => {
  it('refuses every action to staff without orders:update and without a session', async () => {
    const id = await place(world.auto.serviceId);
    const reader = await adminWith(t, ['orders:read']);
    for (const [path, body] of [
      ['accept', {}],
      ['reply', { code: 'x' }],
      ['reject', { reason: 'x' }],
      ['verification', { decision: 'accept' }],
      ['notes', { body: 'x' }],
    ] as const) {
      expect((await reader.post(`/admin/orders/${id}/${path}`, body)).status).toBe(403);
      expect((await staff.anonymous('POST', `/admin/orders/${id}/${path}`, body)).status).toBe(401);
    }
    expect((await staff.withoutCsrf('POST', `/admin/orders/${id}/reject`, { reason: 'x' })).status).toBe(403);
    expect((await orderRow(world.db, id)).status).toBe('pending');
  });
});

describe('concurrency', () => {
  it('posts once when a reply and a reject race on one order: one wins, the other answers 409', async () => {
    const { db, merchant, auto } = world;
    for (let round = 0; round < 3; round += 1) {
      const id = await place(auto.serviceId, IMEIS[round]);
      const results = await Promise.all([
        staff.post(`/admin/orders/${id}/reply`, { code: 'Done' }),
        staff.post(`/admin/orders/${id}/reject`, { reason: 'No' }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([204, 409]);
      const ledger = await ledgerOf(db, id);
      expect(ledger).toHaveLength(2);
      const row = await orderRow(db, id);
      expect(ledger[1]!.kind).toBe(row.status === 'completed' ? 'order_settle' : 'order_release');
      expect(
        (await eventsOf(db, id)).filter((event) => event.type === 'completed' || event.type === 'rejected'),
      ).toHaveLength(1);
      expect(await outboxOf(db, 'order.status_changed', id)).toHaveLength(1);
      expect((await auditOf(db, id)).length).toBe(1);
    }
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(Number((await walletOf(db, merchant.id)).hold)).toBe(0);
  });

  it('settles once when several replies race', async () => {
    const { db, auto } = world;
    const id = await place(auto.serviceId);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => staff.post(`/admin/orders/${id}/reply`, { code: `r${n}` })),
    );
    expect(results.map((res) => res.status).sort()).toEqual([204, 409, 409, 409]);
    expect(await ledgerOf(db, id)).toHaveLength(2);
    expect(await systemBalance(db, 'revenue')).toBe('17.2800');
  });
});
