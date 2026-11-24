// Integration tests of what a balance payment writes for an account (feature 21, plan § 5.6.6; decision 064):
// POST /store/v1/checkout-sessions/:token/balance-payment records the payment under the buyer's `account_id` (never a customer number),
// posts the journal from the account's store wallet owned by `('account', id)` with `created_by ('account', id)`, and a retry under the same
// key answers the same payment without a second journal. The refusals and the races of the route are `balance-pay.test.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, json } from '../../support/b2c';
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
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

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
});

/** An account of the retail rank, signed in on its own address, with a balance. */
async function buyer(balance = '50') {
  const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  await fundCustomer(db, customer.id, balance);
  return { customer, client };
}

describe('POST /store/v1/checkout-sessions/:token/balance-payment, by account', () => {
  it('records the payment, the order and the journal under the account id, with the account as the actor', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token, 'pay-1');
    expect(res.statusCode).toBe(201);
    const body = json(res);

    const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, body.payment.id));
    expect(payment).toMatchObject({
      purpose: 'order',
      methodType: 'balance',
      accountId: customer.id,
      retiredCustomerId: null,
      orderId: body.order.id,
    });
    expect(await orderRow(db, body.order.id)).toMatchObject({ accountId: customer.id, source: 'store' });

    const [journal] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `payment:${payment!.id}:capture`));
    // The actor of the posting is the account (decision 064): never the old word `customer`.
    expect(journal).toMatchObject({
      kind: 'b2c_payment',
      refType: 'order',
      refId: body.order.id,
      createdByType: 'account',
      createdById: customer.id,
    });
    const wallet = await customerWalletRow(db, customer.id);
    expect(wallet).toMatchObject({ ownerType: 'account', ownerId: customer.id, balance: '45.2100' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('answers a retry under the same key with the same payment and posts nothing twice', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const first = await payFromBalance(client, token, 'same-key');
    const again = await payFromBalance(client, token, 'same-key');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual(json(first));
    expect(await db.select().from(s.payments).where(eq(s.payments.accountId, customer.id))).toHaveLength(1);
    expect(
      (await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.createdByType, 'account'))).length,
    ).toBe(1);
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('45.2100');
  });
});
