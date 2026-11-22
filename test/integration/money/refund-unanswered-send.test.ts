// Integration tests of storefront refunds whose send got no answer from the gateway (a timeout, a 5xx) on the real application, Postgres
// and the fake gateway: the gateway's own success for that send completes the refund; a staff retry within 20 hours sends under the same
// idempotency key; later, when the gateway may have forgotten the key (it keeps one 24 hours), neither the retry nor the job sends again,
// so a refund the gateway may already have made is never made twice; a refund that was never sent under its key stays retryable.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule, RefundSender } from '@src/modules/money';
import { UNANSWERED_SEND_NOTE, UNCONFIRMED_SEND_NOTE } from '@src/modules/money/jobs/refund-sender';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  disputeEvent,
  hook,
  paidOrder,
  refundEvent,
} from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { rejectionOf } from '../../support/rejection';
import { eventsOf, ledgerOf } from '../../support/orders';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let sender: RefundSender;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule] });
  sender = t.app.get(RefundSender, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*']);
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const refundRow = async (id: number) => (await db.select().from(s.refunds).where(eq(s.refunds.id, id)))[0]!;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const keys = () => fake.calls('/v1/refunds').map((call) => call.headers['idempotency-key']);

/** The gateway reports a dispute of the whole payment; `status` closes it. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

/** A paid order rejected by staff: its whole payment is booked back and the refund waits for the gateway job. */
async function rejected() {
  const paid = await paidOrder(t, clock, world);
  expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(204);
  const [refund] = await db.select().from(s.refunds);
  expect(refund).toMatchObject({ status: 'processing' });
  return { paid, refund: refund! };
}

/** Every attempt of the job gets a 5xx: the refund fails on the last one and keeps its key. */
async function unanswered(refundId: number) {
  fake.failWith = 503;
  expect(await rejectionOf(sender.send(refundId, false))).toMatchObject({ code: 'GATEWAY_ERROR' });
  expect(await rejectionOf(sender.send(refundId, false))).toMatchObject({ code: 'GATEWAY_ERROR' });
  expect(await sender.send(refundId, true)).toBe('failed');
  fake.failWith = undefined;
  // The note tells staff that the gateway may already have made the refund.
  expect(await refundRow(refundId)).toMatchObject({
    status: 'failed',
    sendAttempt: 1,
    note: `The payment gateway answered 503. ${UNCONFIRMED_SEND_NOTE}`,
  });
}

/** Staff sign in again (the clock may have moved past the idle limit) and press retry. */
async function retry(refundId: number) {
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*']);
  return staff.post(`/admin/refunds/${refundId}/retry`, {});
}

describe('the gateway success of a send that got no answer', () => {
  it('completes the failed refund, so a later chargeback leaves it and its journal in place', async () => {
    const { paid, refund } = await rejected();
    await unanswered(refund.id);
    // The gateway made the refund after all and says so, naming our refund and the send attempt.
    const succeeded = refundEvent(`evt_${unique()}`, {
      refund: 're_made_by_gateway',
      refundId: refund.id,
      sendAttempt: 1,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, succeeded)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'completed',
      gatewayRefundId: 're_made_by_gateway',
      note: '',
      sendAttempt: 1,
    });
    expect((await paymentRow(paid.paymentId)).status).toBe('refunded');
    expect((await eventsOf(db, paid.orderId)).map((line) => (line.data as { message?: string }).message)).toContain(
      'Refund of $4.79 confirmed by the gateway',
    );
    expect((await retry(refund.id)).status).toBe(409);

    // The buyer's bank takes the payment back as well: the gateway paid both, so the books keep both.
    await dispute(paid, 'dp_after_success');
    await dispute(paid, 'dp_after_success', 'lost');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed' });
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'refund',
      'chargeback',
    ]);
    expect(keys()).toHaveLength(3);
  });

  it('a success of a send the gateway refused for good does not complete the refund', async () => {
    const { refund } = await rejected();
    fake.refund = { status: 'pending' };
    expect(await sender.send(refund.id, false)).toBe('pending');
    const first = (await refundRow(refund.id)).gatewayRefundId!;
    const failed = refundEvent(`evt_${unique()}`, {
      refund: first,
      refundId: refund.id,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 2 });
    // An older report of the same gateway refund, delivered after its failure.
    const stale = refundEvent(`evt_${unique()}`, { refund: first, refundId: refund.id, sendAttempt: 1 });
    expect((await hook(t, clock, 'payments', world.gateway.code, stale)).statusCode).toBe(200);
    const noAttempt = refundEvent(`evt_${unique()}`, { refund: first, refundId: refund.id });
    expect((await hook(t, clock, 'payments', world.gateway.code, noAttempt)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 2, gatewayRefundId: first });
  });

  it('a refusal for good of a send that got no answer moves the key on: a later success of that send changes nothing, the retry uses a new key', async () => {
    const { paid, refund } = await rejected();
    await unanswered(refund.id);
    const paymentStatus = (await paymentRow(paid.paymentId)).status;
    // The gateway made a refund object on the send it did not answer, and then refused it for good.
    const failed = refundEvent(`evt_${unique()}`, {
      refund: 're_made',
      refundId: refund.id,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, failed)).statusCode).toBe(200);
    const refused = await refundRow(refund.id);
    expect(refused).toMatchObject({
      status: 'failed',
      sendAttempt: 2,
      unansweredSendAt: null,
      gatewayRefundId: 're_made',
    });
    expect(refused.note).toStartWith(`The payment gateway answered 503. ${UNCONFIRMED_SEND_NOTE}`);
    expect(refused.note).toContain('refund re_made failed: expired_or_canceled_card');
    // A repeated delivery of the refusal, and an older report of the same send delivered after it, change nothing.
    const again = refundEvent(`evt_${unique()}`, {
      refund: 're_made',
      refundId: refund.id,
      sendAttempt: 1,
      type: 'refund.failed',
      failure: 'expired_or_canceled_card',
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, again)).statusCode).toBe(200);
    const stale = refundEvent(`evt_${unique()}`, { refund: 're_made', refundId: refund.id, sendAttempt: 1 });
    expect((await hook(t, clock, 'payments', world.gateway.code, stale)).statusCode).toBe(200);
    const noAttempt = refundEvent(`evt_${unique()}`, { refund: 're_made', refundId: refund.id });
    expect((await hook(t, clock, 'payments', world.gateway.code, noAttempt)).statusCode).toBe(200);
    expect(await refundRow(refund.id)).toEqual(refused);
    expect((await paymentRow(paid.paymentId)).status).toBe(paymentStatus);

    // The refused key is dead, so the retry is accepted at any time and sends under the new key.
    clock.advance(25 * HOUR);
    expect((await retry(refund.id)).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(keys()).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}`,
      `refund-${refund.id}`,
      `refund-${refund.id}-2`,
    ]);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'completed', sendAttempt: 2 });
  });
});

describe('POST /admin/refunds/:id/retry and the job after a send that got no answer', () => {
  it('within 20 hours the retry sends under the same key', async () => {
    const { refund } = await rejected();
    await unanswered(refund.id);
    clock.advance(19 * HOUR);
    expect((await retry(refund.id)).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(keys()).toEqual([
      `refund-${refund.id}`,
      `refund-${refund.id}`,
      `refund-${refund.id}`,
      `refund-${refund.id}`,
    ]);
  });

  it('after 20 hours the retry is refused and nothing is sent', async () => {
    const { refund } = await rejected();
    await unanswered(refund.id);
    clock.advance(25 * HOUR);
    const refused = await retry(refund.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'REFUND_NOT_FAILED' });
    expect(String(refused.body.detail)).toContain('Check the payment at the gateway');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 1 });
    expect(await sender.send(refund.id, false)).toBe('skipped');
    expect(keys()).toHaveLength(3);
  });

  it('a send that runs more than 20 hours after the unanswered one is not made', async () => {
    const { refund } = await rejected();
    await unanswered(refund.id);
    clock.advance(19 * HOUR);
    expect((await retry(refund.id)).status).toBe(200);
    // The job of the retry runs late.
    clock.advance(2 * HOUR);
    expect(await sender.send(refund.id, false)).toBe('failed');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', note: UNANSWERED_SEND_NOTE, sendAttempt: 1 });
    expect(keys()).toHaveLength(3);
    expect((await retry(refund.id)).status).toBe(409);
  });

  it('an unanswered attempt before a dispute counts: the retry after the dispute is refused once 20 hours have passed', async () => {
    const { paid, refund } = await rejected();
    fake.failWith = 503;
    expect(await rejectionOf(sender.send(refund.id, false))).toMatchObject({ code: 'GATEWAY_ERROR' });
    fake.failWith = undefined;
    // The next attempt finds the payment disputed and does not send.
    await dispute(paid, 'dp_unanswered');
    expect(await sender.send(refund.id, true)).toBe('failed');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 1 });
    await dispute(paid, 'dp_unanswered', 'won');
    clock.advance(25 * HOUR);
    expect((await retry(refund.id)).status).toBe(409);
    expect(keys()).toHaveLength(1);
  });

  it('a refund never sent under its key stays retryable whenever the dispute ends', async () => {
    const { paid, refund } = await rejected();
    await dispute(paid, 'dp_never_sent');
    expect(await sender.send(refund.id, true)).toBe('failed');
    await dispute(paid, 'dp_never_sent', 'won');
    clock.advance(25 * HOUR);
    expect((await retry(refund.id)).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(keys()).toEqual([`refund-${refund.id}`]);
  });

  it('a refusal for good starts the new key afresh', async () => {
    const { refund } = await rejected();
    await unanswered(refund.id);
    expect((await retry(refund.id)).status).toBe(200);
    // The retry under the same key is refused for good: the next send uses a new key, never sent before.
    fake.refund = { status: 'failed', failure: 'charge_already_refunded' };
    expect(await sender.send(refund.id, false)).toBe('failed');
    expect(await refundRow(refund.id)).toMatchObject({ status: 'failed', sendAttempt: 2 });
    clock.advance(25 * HOUR);
    fake.refund = { status: 'succeeded' };
    expect((await retry(refund.id)).status).toBe(200);
    expect(await sender.send(refund.id, false)).toBe('completed');
    expect(keys().at(-1)).toBe(`refund-${refund.id}-2`);
  });
});
