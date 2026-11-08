// End-to-end walk of the map scenario `b2c-refund` (a refund before delivery, docs/slices/money.json steps 3, 4, 6 and 7) on the real application, a
// stand-in card gateway and a fake Dhru supplier: the staff decision, the order cancelled with its reversing entry, the worker's refund request with
// an idempotency key and the gateway's signed answer. The steps share one story, so the tests of this file run in order. Step 5 (the customer's
// "refund started" email) and the decline email are the notifications feature's (12a).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { RefundProcessModule, RefundSender } from '../../src/modules/money';
import { SupplierDispatch } from '../../src/modules/suppliers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, hook, paidOrder, refundEvent } from '../support/b2c';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { auditOf, eventsOf, ledgerOf, orderRow, outboxOf, systemBalance } from '../support/orders';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../support/suppliers';

const gateway = new B2cGateway();
const supplier = new FakeDhruSupplier();
const clock = new TestClock('2026-11-07T12:00:00.000Z');
const prefix = testBullPrefix();
let t: TestApp;
let world: B2cWorld;
let staff: AdminApi;
let sender: RefundSender;
let paid: PaidOrder;
let refundId = 0;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, SupplierTestModule, RefundProcessModule],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, (await testDb()).db, gateway);
  const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
  await linkService(world.db, world.att.serviceId, supplierId, { credit: '13.5000' });
  sender = t.app.get(RefundSender, { strict: false });
  staff = await adminWith(t, ['refunds:*', 'orders:read'], { name: 'Layla Haddad' });
  // The story starts with a paid order that waits for the supplier (the dispatch job is queued, nothing is sent yet) and a request.
  paid = await paidOrder(t, clock, world, { serviceId: world.att.serviceId, email: 'jack@mail.example' });
  const customerId = (await orderRow(world.db, paid.orderId)).customerId!;
  const [request] = await world.db
    .insert(s.refunds)
    .values({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      customerId,
      amount: paid.charged,
      currency: 'GBP',
      reason: 'I bought the wrong service',
      method: 'original',
      status: 'requested',
      requestedByType: 'customer',
      requestedById: customerId,
    })
    .returning();
  refundId = request!.id;
});
afterAll(async () => {
  await gateway.stop();
  await supplier.stop();
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const refundRow = async () => (await world.db.select().from(s.refunds).where(eq(s.refunds.id, refundId)))[0]!;

describe('scenario b2c-refund: a refund before delivery', () => {
  it('the starting point: the order is paid, waits for the supplier, and its dispatch job is queued', async () => {
    expect(await orderRow(world.db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending' });
    expect(await outboxOf(world.db, 'order.dispatch_requested', paid.orderId)).toHaveLength(1);
    expect(await systemBalance(world.db, 'customer_funds')).toBe('25.9900');
    expect(await systemBalance(world.db, 'vat_payable')).toBe('5.2000');
  });

  it('step 3: staff decide a full refund to the original card; it needs the permission and is audited', async () => {
    const reader = await adminWith(t, ['refunds:read', 'orders:read']);
    expect((await reader.post(`/admin/refunds/${refundId}/approve`, {})).status).toBe(403);
    const res = await staff.post(`/admin/refunds/${refundId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: refundId,
      status: 'processing',
      method: 'original',
      amount: '31.1900',
      netAmount: '25.9900',
      taxAmount: '5.2000',
      approvedBy: { id: staff.staffId, name: 'Layla Haddad' },
    });
    expect(await refundRow()).toMatchObject({ status: 'processing', approvedBy: staff.staffId, method: 'original' });
    const [audit] = await world.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'refund'));
    expect(audit).toMatchObject({ action: 'approved refund', entityId: refundId, actorId: staff.staffId });
    expect(await auditOf(world.db, paid.orderId)).toBeDefined();
  });

  it('step 4: in one transaction the order is cancelled, the dispatch job is moot, and the reversing entry returns the whole amount with its VAT', async () => {
    expect(await orderRow(world.db, paid.orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
    expect((await orderRow(world.db, paid.orderId)).completedAt).not.toBeNull();
    expect((await eventsOf(world.db, paid.orderId)).map((event) => event.type)).toEqual([
      'created',
      'paid',
      'rejected',
      'refund',
    ]);
    // Dr customer_funds 25.99, Dr vat_payable 5.20, Cr gateway_clearing 31.19: the books are back to the start, only the gateway fee is spent.
    expect((await ledgerOf(world.db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
    ]);
    expect(await systemBalance(world.db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(world.db, 'vat_payable')).toBe('0.0000');
    expect(await systemBalance(world.db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(world.db, 'gateway_clearing')).toBe('-1.2045');
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
    // The queued dispatch job finds a rejected order and sends nothing to the supplier.
    expect(await t.app.get(SupplierDispatch, { strict: false }).run(paid.orderId, { lastAttempt: false })).toEqual({
      status: 'skipped',
      reason: 'not_pending',
    });
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(0);
    // The gateway call is a job: one refund.process row, nothing sent yet.
    expect(await world.db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'))).toHaveLength(
      1,
    );
    expect(gateway.calls('/v1/refunds')).toHaveLength(0);
  });

  it('step 6: the worker asks the gateway for the whole amount with an idempotency key, so a repeat cannot refund twice', async () => {
    gateway.refund = { status: 'pending' };
    expect(await sender.send(refundId, false)).toBe('pending');
    const call = gateway.calls('/v1/refunds')[0]!;
    const form = new URLSearchParams(call.body);
    expect(form.get('payment_intent')).toBe(paid.intent);
    // GBP 25.01 in pence; the refund row holds the amount in the payment currency.
    expect(form.get('amount')).toBe('2501');
    expect(form.get('metadata[refund_id]')).toBe(String(refundId));
    expect(call.headers['idempotency-key']).toBe(`refund-${refundId}`);
    // The gateway has not decided: the refund stays processing, with the gateway's id once it gave one.
    const row = await refundRow();
    expect(row).toMatchObject({ status: 'processing', completedAt: null });
    expect(row.gatewayRefundId).toMatch(/^re_/);
    expect((await world.db.select().from(s.payments).where(eq(s.payments.id, paid.paymentId)))[0]!.status).toBe(
      'captured',
    );
  });

  it('step 7: the signed refund.succeeded event completes the refund, keeps the gateway refund id and marks the payment refunded', async () => {
    const before = await refundRow();
    const event = refundEvent('evt_refund_ok', { refund: before.gatewayRefundId!, refundId });
    expect((await hook(t, clock, 'payments', world.gateway.code, event)).statusCode).toBe(200);
    expect(await refundRow()).toMatchObject({ status: 'completed', gatewayRefundId: before.gatewayRefundId });
    expect((await refundRow()).completedAt?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect((await world.db.select().from(s.payments).where(eq(s.payments.id, paid.paymentId)))[0]!.status).toBe(
      'refunded',
    );
    expect((await eventsOf(world.db, paid.orderId)).at(-1)).toMatchObject({
      type: 'refund',
      data: expect.objectContaining({ message: 'Refund of $31.19 confirmed by the gateway' }),
    });
    // A repeat of the event, and a second run of the job, change nothing and send nothing more.
    const again = refundEvent('evt_refund_again', { refund: before.gatewayRefundId!, refundId });
    expect((await hook(t, clock, 'payments', world.gateway.code, again)).statusCode).toBe(200);
    expect(await sender.send(refundId, false)).toBe('skipped');
    expect(gateway.calls('/v1/refunds')).toHaveLength(1);
    expect((await ledgerOf(world.db, paid.orderId)).filter((entry) => entry.kind === 'refund')).toHaveLength(1);
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });
});
