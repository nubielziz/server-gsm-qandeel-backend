// A held storefront order is released from the risk review only while its payment stands: while the payment is disputed the release waits
// (409, the order stays held for staff) until the dispute is decided, and a payment that was charged back is never released. Real Postgres and
// Redis, a stand-in card gateway and its signed dispute webhooks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { type B2cWorld, B2cGateway, type PaidOrder, b2cWorld, disputeEvent, hook, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, ledgerOf, orderRow, outboxOf } from '../../support/orders';

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
  staff = await adminWith(t, ['orders:*', 'disputes:*', 'risk:*', 'settings:*'], { name: 'Risk reviewer' });
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;

/** A paid storefront order that the rules hold for review (a first order above USD 1 is reviewed). */
async function heldOrder(): Promise<PaidOrder> {
  const rules = (await staff.get('/admin/risk/rules')).body.rules as Array<{
    id: string;
    on: boolean;
    value: number | null;
  }>;
  const changed: Record<string, number> = { reviewFirstOrderAbove: 1, reviewThreshold: 10 };
  const body = { rules: rules.map(({ id, on, value }) => ({ id, on, value: id in changed ? changed[id]! : value })) };
  expect((await staff.put('/admin/risk/rules', body)).status).toBe(200);
  const paid = await paidOrder(t, clock, world);
  expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
  return paid;
}

/** The gateway reports a dispute of the order's payment: opened, or closed as won or lost. */
async function dispute(paid: PaidOrder, gatewayId: string, status?: 'won' | 'lost') {
  const body = disputeEvent(`evt_${unique()}`, {
    dispute: gatewayId,
    intent: paid.intent,
    ...(status === undefined ? {} : { type: 'charge.dispute.closed', status }),
  });
  expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
}

async function paymentStatus(paid: PaidOrder) {
  const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, paid.paymentId));
  return payment!.status;
}

const approve = (paid: PaidOrder) => staff.post(`/admin/risk/orders/${paid.orderId}/approve`, {});

/** The order is still held for review, with no dispatch request and no risk decision on its timeline. */
async function expectStillHeld(paid: PaidOrder) {
  expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
  expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
  expect((await eventsOf(db, paid.orderId)).filter((event) => event.type === 'risk')).toHaveLength(0);
  const queue = await staff.get('/admin/risk/queue');
  expect((queue.body.held as Array<{ orderId: number }>).map((row) => row.orderId)).toContain(paid.orderId);
}

describe('POST /admin/risk/orders/:id/approve and the payment of the order', () => {
  it('does not release a held order whose payment was charged back', async () => {
    const paid = await heldOrder();
    await dispute(paid, 'dp_lost');
    await dispute(paid, 'dp_lost', 'lost');
    expect(await paymentStatus(paid)).toBe('chargeback');

    const res = await approve(paid);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(res.body.detail).toContain('charged back');
    await expectStillHeld(paid);
    // Nothing was delivered or settled for it.
    expect((await ledgerOf(db, paid.orderId)).map((entry) => entry.kind)).not.toContain('order_settle');
  });

  it('keeps a held order whose payment is disputed in the review until the dispute is decided', async () => {
    const paid = await heldOrder();
    await dispute(paid, 'dp_open');
    expect(await paymentStatus(paid)).toBe('disputed');

    const waiting = await approve(paid);
    expect(waiting.status).toBe(409);
    expect(waiting.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(waiting.body.detail).toContain('disputed');
    await expectStillHeld(paid);

    // The dispute is won: the payment stands again and the order is released by the placement rule (no supplier link: the manual queue).
    await dispute(paid, 'dp_open', 'won');
    expect(await paymentStatus(paid)).toBe('captured');
    expect((await approve(paid)).status).toBe(204);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'manual' });
  });
});
