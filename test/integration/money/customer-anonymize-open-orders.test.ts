// Integration tests of the anonymize guard for orders paid from the store balance (feature 21, O12 and risk K11): a customer whose order
// paid from the balance is still open, or whose refund to the balance waits for a decision, is not anonymized, because that money would
// come back to a balance nobody can use or pay out; a delivered order, a rejected order whose refund was brought to zero, a declined refund
// and an open order paid by card do not hold it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, json, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import { seedDefaultTemplates } from '../../support/notifications';
import { orderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, customerRow, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, RefundProcessModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
  await walletSettings(t, db);
  await seedDefaultTemplates(db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['customers:privacy', 'orders:*', 'refunds:*', 'wallet:*']);
});

/** An order of the iCloud check (4.79 USD) paid from a balance of exactly that amount, so the balance is zero afterwards. */
async function balanceOrder(options: { deliver?: boolean } = {}) {
  const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  await fundCustomer(db, customer.id, '4.79');
  const { token } = await openSignedInCheckout(client, world, customer.email);
  const res = await payFromBalance(client, token);
  expect(res.statusCode).toBe(201);
  const body = json(res);
  expect((await customerWalletRow(db, customer.id))!.balance).toBe('0.0000');
  if (options.deliver) {
    expect((await staff.post(`/admin/orders/${body.order.id}/reply`, { code: 'Clean' })).status).toBe(204);
  }
  return { customerId: customer.id, orderId: body.order.id as number, paymentId: body.payment.id as number };
}

/** A customer's refund request on a balance payment (the request route belongs to the support feature). */
async function refundRequest(paid: { customerId: number; orderId: number; paymentId: number }) {
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      customerId: paid.customerId,
      amount: '3.8400',
      currency: 'GBP',
      reason: 'The result was wrong',
      method: 'original',
      status: 'requested',
      requestedByType: 'customer',
      requestedById: paid.customerId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  return row!;
}

const anonymize = (id: number) => staff.post(`/admin/customers/${id}/anonymize`, {});

describe('POST /admin/customers/:id/anonymize with orders paid from the store balance', () => {
  it('is refused while an order paid from the balance is open, and goes through once the order is delivered', async () => {
    const paid = await balanceOrder();
    expect((await orderRow(db, paid.orderId)).status).toBe('pending');

    const refused = await anonymize(paid.customerId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT' });
    expect(refused.body.detail).toContain(`ORD-${paid.orderId}`);
    expect((await customerRow(paid.customerId)).status).toBe('active');

    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Clean' })).status).toBe(204);
    expect((await anonymize(paid.customerId)).status).toBe(204);
    expect((await customerRow(paid.customerId)).status).toBe('anonymized');
  });

  it('after a rejection the refund is on the balance, which must be brought to zero before the anonymize goes through', async () => {
    const paid = await balanceOrder();
    expect((await anonymize(paid.customerId)).status).toBe(409);
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('4.7900');

    const refused = await anonymize(paid.customerId);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain('4.7900 USD');
    const adjusted = await staff.post(
      `/admin/customers/${paid.customerId}/wallet/adjust`,
      { amount: '4.7900', direction: 'debit', reason: 'Paid out before the erasure' },
      { 'idempotency-key': 'close' },
    );
    expect(adjusted.status).toBe(200);
    expect((await anonymize(paid.customerId)).status).toBe(204);
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('is refused while a refund to the balance waits for a decision, and goes through once it is declined', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await refundRequest(paid);

    const refused = await anonymize(paid.customerId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT' });
    expect(refused.body.detail).toContain(`RF-${refund.id}`);
    expect((await customerRow(paid.customerId)).status).toBe('active');

    const declined = await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'The result was correct.' });
    expect(declined.status).toBe(200);
    expect((await anonymize(paid.customerId)).status).toBe(204);
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('0.0000');
  });

  it('an approved refund to the balance leaves a balance, so the anonymize stays refused until it is zero', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await refundRequest(paid);
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    expect((await customerWalletRow(db, paid.customerId))!.balance).toBe('4.7900');

    const refused = await anonymize(paid.customerId);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain('4.7900 USD');
    expect((await customerRow(paid.customerId)).status).toBe('active');
  });

  it('an open order paid by card does not hold the anonymize', async () => {
    const order = await paidOrder(t, clock, world, { email: 'card.buyer@example.com' });
    const row = await orderRow(db, order.orderId);
    expect(row.status).toBe('pending');
    expect(row.customerId).not.toBeNull();
    expect((await anonymize(row.customerId!)).status).toBe(204);
    const [customer] = await db.select().from(s.customers).where(eq(s.customers.id, row.customerId!));
    expect(customer!.status).toBe('anonymized');
  });
});
