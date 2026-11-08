// Integration tests of the risk review queue and the decisions on a held order (feature 18, GET /admin/risk/queue and POST
// /admin/risk/orders/:id/approve and /refund; scenario b2c-paid): what the queue shows, release to dispatch or the manual queue,
// the refund with its ledger move and blocklist entries, the refusals, the race between two reviewers and the permissions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { AuditService } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import {
  type OrdersWorld,
  eventsOf,
  ledgerOf,
  orderRow,
  ordersWorld,
  outboxOf,
  systemBalance,
} from '../support/orders';
import { assessmentOf, auditRows, blocklistRows, insertHeldOrder } from '../support/risk';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

/** Sets the USD gross a checkout session locked. */
const lockGross = (sessionId: number, gross: string) =>
  world.db.update(s.checkoutSessions).set({ grossAmount: gross }).where(eq(s.checkoutSessions.id, sessionId));

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['risk:read', 'risk:decide'], { name: 'Rami K.' });
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('GET /admin/risk/queue', () => {
  it('is empty with zero figures when nothing is held', async () => {
    const res = await staff.get('/admin/risk/queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      held: [],
      stats: { decided30d: 0, approved30d: 0, refunded30d: 0, heldShare: 0 },
      recent: [],
    });
    expect(res.res.headers['cache-control']).toBe('no-store');
  });

  it('shows a held order with the service, supplier, device, amount, method, signals and the buyer’s history', async () => {
    const { db } = world;
    await db.insert(s.tacCatalog).values({
      tac: '35389011',
      brand: 'Xiaomi',
      model: '23021RAAEG',
      marketingName: 'Redmi Note 12',
      source: 'test',
    });
    const held = await insertHeldOrder(world, {
      imei: '353890113898412',
      createdAt: new Date('2026-11-08T11:00:00.000Z'),
    });
    const res = await staff.get('/admin/risk/queue');
    expect(res.status).toBe(200);
    expect(res.body.held).toHaveLength(1);
    expect(res.body.held[0]).toMatchObject({
      orderId: held.orderId,
      paidAt: '2026-11-08T11:00:00.000Z',
      score: 62,
      service: { id: world.auto.serviceId, name: 'AT&T USA Premier Unlock' },
      supplier: { id: world.auto.supplierId },
      imei: '353890113898412',
      device: 'Redmi Note 12 (23021RAAEG)',
      capturedAmount: '14.9900',
      currency: 'USD',
      paymentMethod: 'card',
      signals: ['Disposable email domain', 'IP country differs from card country'],
      customer: {
        id: held.customerId,
        name: 'Jack Turner',
        country: 'GB',
        riskLevel: 'low',
        history: { earlierOrders: 0, refunds: 0, disputes: 0 },
      },
    });
    expect(res.body.held[0].fxRate).toMatch(/^1(\.0+)?$/);
  });

  it('lists the oldest payment first, leaves out an order that is not held, and counts the buyer’s earlier orders', async () => {
    const { db } = world;
    const newer = await insertHeldOrder(world, { createdAt: new Date('2026-11-08T11:30:00.000Z') });
    const older = await insertHeldOrder(world, { createdAt: new Date('2026-11-08T08:00:00.000Z') });
    await insertHeldOrder(world, { dispatchState: 'pending' });
    // Two earlier orders of the newer order's buyer, so its history says 2.
    await db.insert(s.orders).values(
      [1, 2].map((day) => ({
        customerId: newer.customerId,
        serviceId: world.auto.serviceId,
        type: 'imei' as const,
        source: 'store' as const,
        unitPrice: '5.0000',
        totalPrice: '5.0000',
        currency: 'USD',
        createdAt: new Date(`2026-11-0${day}T10:00:00.000Z`),
      })),
    );
    const res = await staff.get('/admin/risk/queue');
    expect(res.body.held.map((row: { orderId: number }) => row.orderId)).toEqual([older.orderId, newer.orderId]);
    expect(res.body.held[1].customer.history.earlierOrders).toBe(2);
  });

  it('counts only the orders the buyer created before the held one: not a later order, not another held order of theirs', async () => {
    const { db } = world;
    const first = await insertHeldOrder(world, { createdAt: new Date('2026-11-08T08:00:00.000Z') });
    // The same buyer holds a second and a third order later; one earlier order was delivered.
    const second = await insertHeldOrder(world, {
      customerId: first.customerId,
      createdAt: new Date('2026-11-08T09:00:00.000Z'),
    });
    const third = await insertHeldOrder(world, {
      customerId: first.customerId,
      createdAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    await db.insert(s.orders).values({
      customerId: first.customerId,
      serviceId: world.auto.serviceId,
      type: 'imei',
      source: 'store',
      unitPrice: '5.0000',
      totalPrice: '5.0000',
      currency: 'USD',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
    });
    // And an order of theirs that came after all of them.
    await db.insert(s.orders).values({
      customerId: first.customerId,
      serviceId: world.auto.serviceId,
      type: 'imei',
      source: 'store',
      unitPrice: '5.0000',
      totalPrice: '5.0000',
      currency: 'USD',
      createdAt: new Date('2026-11-08T11:00:00.000Z'),
    });
    const history = (await staff.get('/admin/risk/queue')).body.held.map(
      (row: { orderId: number; customer: { history: { earlierOrders: number } } }) => [
        row.orderId,
        row.customer.history.earlierOrders,
      ],
    );
    // 1: the delivered order of the 5th; 2: that one and the first held order; 3: those two and the second held order.
    expect(history).toEqual([
      [first.orderId, 1],
      [second.orderId, 2],
      [third.orderId, 3],
    ]);
  });

  it('prints the USD gross the checkout locked as the captured amount, the figure the Refunds page shows', async () => {
    const held = await insertHeldOrder(world);
    // The session keeps the gross it locked; the order's own net and VAT may be rounded differently.
    await lockGross(held.sessionId, '14.9800');
    const queue = (await staff.get('/admin/risk/queue')).body;
    expect(queue.held[0].capturedAmount).toBe('14.9800');
    expect((await staff.post(`/admin/risk/orders/${held.orderId}/approve`)).status).toBe(204);
    expect((await staff.get('/admin/risk/queue')).body.recent[0].capturedAmount).toBe('14.9800');
  });

  it('names the device null when the TAC is unknown, and falls back to brand and model without a marketing name', async () => {
    const { db } = world;
    await insertHeldOrder(world, { imei: '352905112490861' });
    expect((await staff.get('/admin/risk/queue')).body.held[0].device).toBeNull();
    await db.insert(s.tacCatalog).values({ tac: '35290511', brand: 'Samsung', model: 'Galaxy S23', source: 'test' });
    expect((await staff.get('/admin/risk/queue')).body.held[0].device).toBe('Samsung Galaxy S23');
  });

  it('counts the last 30 days and lists the six latest decisions, newest first', async () => {
    const { db } = world;
    const decided: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const held = await insertHeldOrder(world);
      decided.push(held.orderId);
      expect(
        (
          await staff.post(
            `/admin/risk/orders/${held.orderId}/${i % 3 === 0 ? 'refund' : 'approve'}`,
            i % 3 === 0 ? {} : undefined,
          )
        ).status,
      ).toBe(204);
      clock.advance(MINUTE);
    }
    await insertHeldOrder(world);
    const res = await staff.get('/admin/risk/queue');
    expect(res.body.held).toHaveLength(1);
    expect(res.body.recent).toHaveLength(6);
    expect(res.body.recent.map((row: { orderId: number }) => row.orderId)).toEqual([...decided].reverse().slice(0, 6));
    expect(res.body.recent[0]).toMatchObject({
      outcome: 'refunded',
      reviewedBy: { name: 'Rami K.' },
      customer: { name: 'Jack Turner' },
      capturedAmount: '14.9900',
    });
    // 7 decisions: i = 0, 3, 6 refunded (3), the other four approved; 8 storefront orders, all review at some time.
    expect(res.body.stats).toMatchObject({ decided30d: 7, approved30d: 4, refunded30d: 3 });
    expect(res.body.stats.heldShare).toBe(100);
    // A decision older than 30 days no longer counts (the window is judged on the clock).
    await db
      .update(s.riskAssessments)
      .set({ reviewedAt: new Date(clock.nowMs() - 31 * DAY) })
      .where(eq(s.riskAssessments.orderId, decided[0]!));
    const later = await staff.get('/admin/risk/queue');
    expect(later.body.stats).toMatchObject({ decided30d: 6, approved30d: 4, refunded30d: 2 });
  });

  it('needs risk:read', async () => {
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/risk/queue')).status).toBe(403);
    expect((await nobody.anonymous('GET', '/admin/risk/queue')).status).toBe(401);
  });
});

describe('POST /admin/risk/orders/:id/approve', () => {
  it('releases the order to the dispatch job, records who decided, writes the timeline and the audit row', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world);
    const res = await staff.post(`/admin/risk/orders/${held.orderId}/approve`);
    expect(res.status).toBe(204);
    const order = await orderRow(db, held.orderId);
    expect(order).toMatchObject({ status: 'pending', dispatchState: 'pending' });
    expect(await outboxOf(db, 'order.dispatch_requested', held.orderId)).toHaveLength(1);
    const assessment = await assessmentOf(db, held.orderId);
    expect(assessment).toMatchObject({ outcome: 'approved', reviewedBy: staff.staffId });
    expect(assessment.reviewedAt?.toISOString()).toBe('2026-11-08T12:00:00.000Z');
    const events = await eventsOf(db, held.orderId);
    expect(events.at(-1)).toMatchObject({ type: 'risk', actorType: 'staff', actorId: staff.staffId });
    expect(events.at(-1)!.data).toMatchObject({ message: 'Risk review: approved, sent to the supplier' });
    const [audit] = await auditRows(db, 'order', held.orderId);
    expect(audit).toMatchObject({
      action: 'approved after risk review',
      entityLabel: `ORD-${held.orderId} for Jack Turner`,
      before: { risk_decision: 'review' },
      after: { risk_decision: 'approved' },
    });
    // The money stays where the payment put it until the order is delivered.
    expect(await systemBalance(db, 'customer_funds')).toBe('12.4900');
    // The queue no longer lists it.
    expect((await staff.get('/admin/risk/queue')).body.held).toEqual([]);
  });

  it('releases an order of a manual service to the manual queue and sends nothing to a supplier', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { serviceId: world.manual.serviceId });
    expect((await staff.post(`/admin/risk/orders/${held.orderId}/approve`)).status).toBe(204);
    expect(await orderRow(db, held.orderId)).toMatchObject({ status: 'pending', dispatchState: 'manual' });
    expect(await outboxOf(db, 'order.dispatch_requested', held.orderId)).toHaveLength(0);
    expect((await eventsOf(db, held.orderId)).at(-1)!.data).toMatchObject({
      message: 'Risk review: approved, sent to the manual queue',
    });
  });

  it('answers 409 NOT_HELD the second time, and for an order that was never held', async () => {
    const held = await insertHeldOrder(world);
    expect((await staff.post(`/admin/risk/orders/${held.orderId}/approve`)).status).toBe(204);
    const again = await staff.post(`/admin/risk/orders/${held.orderId}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_HELD');
    const open = await insertHeldOrder(world, { dispatchState: 'pending' });
    expect((await staff.post(`/admin/risk/orders/${open.orderId}/approve`)).body.code).toBe('NOT_HELD');
    expect((await staff.post(`/admin/risk/orders/${open.orderId}/refund`, {})).body.code).toBe('NOT_HELD');
  });

  it('answers 404 for an unknown order and for an order without an assessment', async () => {
    const { db } = world;
    expect((await staff.post('/admin/risk/orders/999999/approve')).status).toBe(404);
    const held = await insertHeldOrder(world);
    await db.delete(s.riskAssessments).where(eq(s.riskAssessments.orderId, held.orderId));
    expect((await staff.post(`/admin/risk/orders/${held.orderId}/approve`)).status).toBe(404);
  });

  it('lets exactly one of two reviewers decide when both act at once', async () => {
    const { db } = world;
    const second = await adminWith(t, ['risk:decide'], { name: 'Lina S.' });
    const held = await insertHeldOrder(world);
    const [a, b] = await Promise.all([
      staff.post(`/admin/risk/orders/${held.orderId}/approve`),
      second.post(`/admin/risk/orders/${held.orderId}/refund`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const order = await orderRow(db, held.orderId);
    const winner = a.status === 204 ? 'approved' : 'refunded';
    expect((await assessmentOf(db, held.orderId)).outcome).toBe(winner);
    expect(order.dispatchState).toBe(winner === 'approved' ? 'pending' : 'done');
    expect((await auditRows(db, 'order', held.orderId)).length).toBe(1);
  });

  it('needs risk:decide', async () => {
    const held = await insertHeldOrder(world);
    const reader = await adminWith(t, ['risk:read']);
    expect((await reader.post(`/admin/risk/orders/${held.orderId}/approve`)).status).toBe(403);
    expect((await reader.post(`/admin/risk/orders/${held.orderId}/refund`, {})).status).toBe(403);
    expect((await orderRow(world.db, held.orderId)).dispatchState).toBe('held');
  });
});

describe('POST /admin/risk/orders/:id/refund', () => {
  it('rejects the order without a supplier, returns the whole payment and adds the chosen blocklist entries', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { imei: '353890113898412' });
    const res = await staff.post(`/admin/risk/orders/${held.orderId}/refund`, {
      reason: 'Card owner did not match the IMEI buyer',
      blockEmail: true,
      blockDevice: true,
    });
    expect(res.status).toBe(204);
    const order = await orderRow(db, held.orderId);
    expect(order).toMatchObject({
      status: 'rejected',
      dispatchState: 'done',
      resultCode: 'Card owner did not match the IMEI buyer',
    });
    expect(order.completedAt).not.toBeNull();
    expect(order.supplierId).toBeNull();
    // The ledger: customer funds, VAT and the gateway account return to where they were before the payment.
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerOf(db, held.orderId)).map((entry) => entry.kind)).toEqual(['b2c_payment', 'refund']);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Nothing is dispatched and the status change goes out.
    expect(await outboxOf(db, 'order.dispatch_requested', held.orderId)).toHaveLength(0);
    expect(await outboxOf(db, 'order.status_changed', held.orderId)).toHaveLength(1);
    expect(await assessmentOf(db, held.orderId)).toMatchObject({ outcome: 'refunded', reviewedBy: staff.staffId });
    const events = await eventsOf(db, held.orderId);
    expect(events.slice(-2).map((event) => event.type)).toEqual(['risk', 'refund']);
    expect(events.at(-2)!.data).toMatchObject({ reason: 'Card owner did not match the IMEI buyer' });
    // The blocklist entries are the caller's manual entries and are not linked to a customer.
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['email', 'imei']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        source: 'manual',
        createdBy: staff.staffId,
        customerId: null,
        reason: 'Card owner did not match the IMEI buyer',
      });
    }
    // The customer is not blocked by this route (B77).
    const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, held.customerId));
    expect(customer!.status).toBe('active');
    const [audit] = await auditRows(db, 'order', held.orderId);
    expect(audit).toMatchObject({ action: 'refunded after risk review', after: { risk_decision: 'refunded' } });
    // The audit row names the entries it added by kind and mask: no readable IMEI, no full email.
    expect(audit!.after).toMatchObject({
      blocked: [expect.stringMatching(/^email bu\*{4}@example\.com$/), 'imei 35389011•••••••'],
    });
    for (const text of ['353890113898412', '35 389011 389841 2', '389841']) {
      expect(JSON.stringify(audit), text).not.toContain(text);
    }
  });

  it('writes the default reason from the first signal and blocks nothing when no switch is on', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { signals: ['Prepaid card BIN', 'VPN or proxy IP'] });
    expect(
      (await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { blockEmail: false, blockDevice: false })).status,
    ).toBe(204);
    expect((await orderRow(db, held.orderId)).resultCode).toBe('Refunded after risk review: Prepaid card BIN');
    expect(await blocklistRows(db)).toEqual([]);
  });

  it('skips an entry that already exists, without an error and without linking it', async () => {
    const { db } = world;
    const first = await insertHeldOrder(world, { customer: { email: 'first@example.com' }, imei: '353890113898412' });
    const second = await insertHeldOrder(world, { customer: { email: 'second@example.com' }, imei: '353890113898412' });
    const body = { reason: 'Fraud', blockEmail: true, blockDevice: true };
    expect((await staff.post(`/admin/risk/orders/${first.orderId}/refund`, body)).status).toBe(204);
    expect((await staff.post(`/admin/risk/orders/${second.orderId}/refund`, body)).status).toBe(204);
    // The same IMEI is one entry; each email is its own.
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['email', 'email', 'imei']);
    expect(entries.every((entry) => entry.customerId === null)).toBe(true);
  });

  it('does not fail the refund because one value cannot be blocked (a malformed email is skipped)', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { customer: { email: 'not-an-address' }, imei: '353890113898412' });
    expect(
      (await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { blockEmail: true, blockDevice: true })).status,
    ).toBe(204);
    expect((await blocklistRows(db)).map((entry) => entry.kind)).toEqual(['imei']);
  });

  it('blocks no device when the order has no IMEI', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { imei: 'SN-1234' });
    expect(
      (await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { blockEmail: false, blockDevice: true })).status,
    ).toBe(204);
    expect(await blocklistRows(db)).toEqual([]);
  });

  it('validates the body: a reason that is too long is a 422', async () => {
    const held = await insertHeldOrder(world);
    const res = await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { reason: 'x'.repeat(301) });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe('reason');
    expect((await orderRow(world.db, held.orderId)).dispatchState).toBe('held');
  });

  it('rolls everything back when a later step of the refund fails', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world);
    // The audit row is the last write of the decision: if it fails, the order move before it must be undone too.
    spyOn(AuditService.prototype, 'record').mockRejectedValueOnce(new Error('the audit write failed'));
    const res = await staff.post(`/admin/risk/orders/${held.orderId}/refund`, { blockEmail: true });
    expect(res.status).toBe(500);
    mock.restore();
    expect(await blocklistRows(db)).toEqual([]);
    expect((await assessmentOf(db, held.orderId)).reviewedAt).toBeNull();
    expect(await orderRow(db, held.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
    expect((await ledgerOf(db, held.orderId)).map((entry) => entry.kind)).toEqual(['b2c_payment']);
    expect(await auditRows(db, 'order', held.orderId)).toEqual([]);
    expect((await eventsOf(db, held.orderId)).some((event) => event.type === 'risk')).toBe(false);
  });
});
