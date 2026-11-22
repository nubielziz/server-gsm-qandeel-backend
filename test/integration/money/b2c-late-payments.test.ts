// Integration tests of the payments made after a checkout's price lock ended (decision 048): a payment made more than 30 minutes after
// the lock is not used at the old price. It is booked on an order placed held for review and refunded at once when the gateway can refund;
// otherwise (crypto, a gateway without refunds) the order waits in the risk queue. Lateness is judged on when the buyer paid.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { LATE_REFUND_REASON, RefundProcessModule } from '@src/modules/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, b2cWorld, hook, json, openCheckout, pay, storefrontEvent } from '../../support/b2c';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  insertGateway,
  postWebhook,
  signedHeaders,
} from '../../support/billing';
import { insertSupplierLink } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow } from '../../support/orders';
import { assessmentOf } from '../../support/risk';

const T0 = '2026-11-21T12:00:00.000Z';
const clock = new TestClock(T0);
const fake = new B2cGateway();
const crypto = new FakeGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule] });
});
afterAll(async () => {
  await fake.stop();
  await crypto.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set(T0);
  fake.reset();
  crypto.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  await insertSupplierLink(db, world.icloud.serviceId);
  await seedDefaultTemplates(db);
});

const unique = () => `${++counter}_${globalThis.crypto.randomUUID().slice(0, 6)}`;
const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * MINUTE);
const seconds = (minutes: number) => Math.floor(at(minutes).getTime() / 1000);
const refundRows = () => db.select().from(s.refunds);
const refundEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'));
const orderOf = async (paymentId: number) =>
  (await db.select().from(s.payments).where(eq(s.payments.id, paymentId)))[0]!.orderId;

/** Opens a GBP checkout at T0 and its card page a minute later. */
async function cardCheckout() {
  const { token } = await openCheckout(t, world);
  clock.set(at(1));
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  return { token, payment: json(started).payment as { id: number; reference: string; amount: string } };
}

/** The card confirmation of a payment the buyer made at `paidAt` minutes, delivered at `deliveredAt` minutes. */
async function confirmCard(payment: { reference: string; amount: string }, paidAt: number, deliveredAt: number) {
  clock.set(at(deliveredAt));
  const body = storefrontEvent(`evt_${unique()}`, payment.reference, {
    amount: payment.amount,
    created: seconds(paidAt),
    chargedAt: seconds(paidAt),
  });
  const res = await hook(t, clock, 'payments', world.gateway.code, body);
  expect(res.statusCode).toBe(200);
}

describe('a payment made after the price lock ended (decision 048)', () => {
  it('a card payment made more than 30 minutes after the price lock ended is refunded at once', async () => {
    const { token, payment } = await cardCheckout();
    await confirmCard(payment, 61, 61);
    const orderId = (await orderOf(payment.id))!;
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'rejected', dispatchState: 'done' });
    expect((await ledgerOf(db, orderId)).map((entry) => entry.kind)).toEqual(['b2c_payment', 'gateway_fee', 'refund']);
    const refunds = await refundRows();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId: payment.id,
      orderId,
      status: 'processing',
      requestedByType: 'system',
      method: 'original',
    });
    expect(await refundEvents()).toHaveLength(1);
    const mails = (await notificationRows(db)).map((row) => row.event);
    expect(mails).toContain('order.failed');
    expect(mails).not.toContain('order.received');
    const assessment = await assessmentOf(db, orderId);
    expect(assessment).toMatchObject({ decision: 'review', outcome: 'refunded' });
    expect(assessment.signals[0]).toBe("Paid 31 minutes after the checkout's price lock ended");
    // The refund says why, in the words the buyer reads.
    const reasons = (await eventsOf(db, orderId)).map((event) => event.data['reason']);
    expect(reasons).toContain(LATE_REFUND_REASON);
    const [session] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.orderId, orderId));
    expect(session).toMatchObject({ status: 'paid' });
    expect(token).not.toBe('');
  });

  it('a card payment made within the grace is captured as usual', async () => {
    const { payment } = await cardCheckout();
    await confirmCard(payment, 59, 59);
    const orderId = (await orderOf(payment.id))!;
    expect((await orderRow(db, orderId)).status).not.toBe('rejected');
    expect((await orderRow(db, orderId)).dispatchState).not.toBe('held');
    expect(await refundRows()).toHaveLength(0);
    expect((await notificationRows(db)).map((row) => row.event)).toContain('order.received');
  });

  it('a payment made in time and delivered late is captured', async () => {
    const { payment } = await cardCheckout();
    await confirmCard(payment, 10, 90);
    const orderId = (await orderOf(payment.id))!;
    expect((await orderRow(db, orderId)).dispatchState).not.toBe('held');
    expect(await refundRows()).toHaveLength(0);
    expect((await assessmentOf(db, orderId)).decision).toBe('allow');
  });

  it('a late payment the method cannot send back waits in the risk queue, and staff can release it', async () => {
    await db
      .update(s.paymentGateways)
      .set({ supportsRefunds: false })
      .where(eq(s.paymentGateways.id, world.gateway.id));
    const { payment } = await cardCheckout();
    await confirmCard(payment, 75, 75);
    const orderId = (await orderOf(payment.id))!;
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'held' });
    expect(await refundRows()).toHaveLength(0);
    // Signed in now: the clock moved past the session's idle time.
    const risk: AdminApi = await adminWith(t, ['risk:*'], { name: 'Rami K.' });
    const queue = await risk.get('/admin/risk/queue');
    expect(queue.status).toBe(200);
    const listed = queue.body.held.find((row: { orderId: number }) => row.orderId === orderId);
    expect(listed.signals[0]).toBe("Paid 45 minutes after the checkout's price lock ended");
    expect((await risk.post(`/admin/risk/orders/${orderId}/approve`)).status).toBe(204);
    // Released by the placement rule: the service has an active supplier link.
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'pending' });
  });

  it('a late crypto payment waits in the risk queue', async () => {
    await insertGateway(t, db, {
      code: 'crypto-b2c',
      name: 'Crypto gateway',
      driver: 'crypto',
      audience: 'b2c',
      apiBase: crypto.url,
    });
    const { token } = await openCheckout(t, world);
    clock.set(at(1));
    const started = await pay(t, token, {
      gateway: 'crypto-b2c',
      returnUrl: 'http://localhost:5175/en/checkout/return',
    });
    expect(started.statusCode).toBe(201);
    const payment = json(started).payment as { id: number; reference: string; amount: string; method: string };
    expect(payment.method).toBe('crypto');
    const invoice = `cinv_${unique()}`;
    crypto.status.set(invoice, {
      status: 'confirmed',
      confirmations: 3,
      requiredConfirmations: 3,
      amount: payment.amount,
      currency: 'GBP',
      reference: payment.reference,
    });
    clock.set(at(61));
    const body = JSON.stringify({
      id: `evt_${unique()}`,
      type: 'invoice.confirmed',
      created: seconds(61),
      data: {
        id: invoice,
        reference: payment.reference,
        amount: payment.amount,
        currency: 'GBP',
        confirmations: 3,
        requiredConfirmations: 3,
        coin: 'usdt',
        network: 'TRC-20',
      },
    });
    const res = await postWebhook(t, 'crypto-b2c', body, signedHeaders(WEBHOOK_KEY, body, clock, 'x-gsm-signature'));
    expect(res.statusCode).toBe(200);
    const orderId = (await orderOf(payment.id))!;
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'held' });
    expect(await refundRows()).toHaveLength(0);
    expect((await assessmentOf(db, orderId)).signals[0]).toBe("Paid 31 minutes after the checkout's price lock ended");
  });
});
