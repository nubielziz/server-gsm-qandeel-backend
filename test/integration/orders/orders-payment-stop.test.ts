// A storefront order whose payment is disputed, charged back or refunded in full is not accepted or completed by staff: the single accept
// and reply and the bulk reply's apply answer 409 INVALID_TRANSITION with the sentence of the payment, nothing is written, and a reject
// stays allowed. After the dispute is won the order is worked again. Real Postgres and Redis and a stand-in card gateway with its signed
// dispute webhooks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '@src/infra/db';
import { PAYMENT_STOP_REASONS } from '@src/modules/orders';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import { seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow, systemBalance } from '../../support/orders';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;
let counter = 0;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  staff = await adminWith(t, ['orders:*', 'refunds:*', 'disputes:*'], { name: 'Order desk' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;

/** The gateway reports a dispute of the order's payment: opened, or closed as won or lost. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

/** A paid storefront order in the manual queue (the shop's service has no supplier). */
async function manualOrder(): Promise<PaidOrder> {
  const paid = await paidOrder(t, clock, world);
  expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'manual' });
  return paid;
}

const post = (orderId: number, action: string, body: unknown = {}) =>
  staff.post(`/admin/orders/${orderId}/${action}`, body);

/** The action was refused for the payment and changed nothing. */
async function expectRefused(
  res: { status: number; body: Record<string, unknown> },
  paid: PaidOrder,
  before: { status: string; dispatchState: string },
  sentence: string,
) {
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION', detail: sentence });
  expect(await orderRow(db, paid.orderId)).toMatchObject(before);
  expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).not.toContain('order_settle');
}

describe('staff actions on a storefront order whose payment does not stand', () => {
  it('a disputed payment: accept, reply and the bulk reply are refused, a reject is allowed', async () => {
    const paid = await manualOrder();
    await dispute(paid, 'dp_desk');
    const before = { status: 'pending', dispatchState: 'manual' };
    await expectRefused(await post(paid.orderId, 'accept'), paid, before, PAYMENT_STOP_REASONS.disputed);
    await expectRefused(
      await post(paid.orderId, 'reply', { code: 'Unlocked' }),
      paid,
      before,
      PAYMENT_STOP_REASONS.disputed,
    );
    const bulk = await staff.post('/admin/orders/bulk-reply/apply', {
      items: [{ orderId: paid.orderId, code: 'Unlocked' }],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({
      applied: 0,
      failed: [{ orderId: paid.orderId, title: PAYMENT_STOP_REASONS.disputed }],
    });
    expect(await orderRow(db, paid.orderId)).toMatchObject(before);
    expect((await eventsOf(db, paid.orderId)).map((event) => event.type)).not.toContain('completed');
    expect((await post(paid.orderId, 'reject', { reason: 'Cannot be unlocked' })).status).toBe(204);
    expect((await orderRow(db, paid.orderId)).status).toBe('rejected');
  });

  it('a charged-back payment: an order accepted before the loss cannot be completed, by one reply or by the bulk reply', async () => {
    const paid = await manualOrder();
    expect((await post(paid.orderId, 'accept')).status).toBe(204);
    await dispute(paid, 'dp_lost');
    await dispute(paid, 'dp_lost', 'lost');
    const before = { status: 'processing', dispatchState: 'operator' };
    await expectRefused(
      await post(paid.orderId, 'reply', { code: 'Unlocked' }),
      paid,
      before,
      PAYMENT_STOP_REASONS.returned,
    );
    const bulk = await staff.post('/admin/orders/bulk-reply/apply', {
      items: [{ orderId: paid.orderId, code: 'Unlocked' }],
    });
    expect(bulk.body).toEqual({
      applied: 0,
      failed: [{ orderId: paid.orderId, title: PAYMENT_STOP_REASONS.returned }],
    });
    expect(await orderRow(db, paid.orderId)).toMatchObject(before);
    expect((await post(paid.orderId, 'reject', { reason: 'Cannot be unlocked' })).status).toBe(204);
  });

  for (const reopenFirst of [false, true]) {
    it(`an order delivered before and reopened ${reopenFirst ? 'before' : 'after'} its payment is charged back is delivered again by a reply`, async () => {
      const paid = await manualOrder();
      expect((await post(paid.orderId, 'reply', { code: 'Unlocked' })).status).toBe(204);
      if (reopenFirst) expect((await post(paid.orderId, 'reopen')).status).toBe(204);
      await dispute(paid, 'dp_again');
      await dispute(paid, 'dp_again', 'lost');
      if (!reopenFirst) expect((await post(paid.orderId, 'reopen')).status).toBe(204);
      expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'processing', dispatchState: 'operator' });

      expect((await post(paid.orderId, 'reply', { code: 'Unlocked again' })).status).toBe(204);
      expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'completed', dispatchState: 'done' });
      // The second delivery is its own settlement; the books end as a delivered order with the plain chargeback loss.
      expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.key)).toContain(`order:${paid.orderId}:settle:2`);
      expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
      expect((await ledgerTotals(db)).sum).toBe('0.0000');
    });
  }

  it('after the dispute is won the order is accepted and completed again', async () => {
    const paid = await manualOrder();
    await dispute(paid, 'dp_won');
    expect((await post(paid.orderId, 'accept')).status).toBe(409);
    await dispute(paid, 'dp_won', 'won');
    expect((await post(paid.orderId, 'accept')).status).toBe(204);
    expect((await post(paid.orderId, 'reply', { code: 'Unlocked' })).status).toBe(204);
    expect((await orderRow(db, paid.orderId)).status).toBe('completed');
  });
});
