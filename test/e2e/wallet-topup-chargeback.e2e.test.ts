// End-to-end walk of a store balance top-up chargeback (feature 21, beyond the map's 13 scenarios, plan § 5.6.9 and O11) on the real
// application: a card top-up is confirmed and credited by the automatic credit, the customer spends part of it from the balance, the
// gateway opens a dispute (the balance is put on hold and cannot pay), the dispute is lost (the credit is taken back, the balance goes below
// zero and stays frozen), staff collect it with an audited adjustment and lift the hold. Each step asserts the journal kinds and that the
// books sum to zero and reconcile. The steps share one story, so the tests run in order.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { PaymentAutoCredit, PaymentAutoCreditModule } from '@src/modules/money';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { hook } from '../support/b2c';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  postWebhook,
  signedHeaders,
} from '../support/billing';
import { MINUTE, TestClock } from '../support/clock';
import {
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { freshClientIp } from '../support/pipeline-routes';
import { type StorefrontWorld, storefrontWorld } from '../support/storefront';
import { type MadeCustomer, STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let world: StorefrontWorld;
let staff: AdminApi;
let customer: MadeCustomer;
let store: StoreClient;
let reference = '';

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, PaymentAutoCreditModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  world = await storefrontWorld(db);
  await walletSettings(t, db, { 'wallet.customer.card_topups': true });
  await insertWalletTemplates(db);
  await insertGateway(t, db, { code: 'card', name: 'Card', driver: 'card', audience: 'b2c', apiBase: fake.url });
  staff = await adminWith(t, ['wallet:*', 'payments:read'], { name: 'Layla Haddad' });
  customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  store = new StoreClient(t, freshClientIp());
  expect((await store.login(customer.email)).statusCode).toBe(200);
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

async function journalKinds(): Promise<string[]> {
  const { db } = await testDb();
  return (await db.select().from(s.ledgerTransactions).orderBy(s.ledgerTransactions.id)).map((row) => row.kind);
}
async function booksClean(): Promise<void> {
  const { db } = await testDb();
  expect((await ledgerTotals(db)).sum).toBe('0.0000');
  expect(await findBalanceDifferences(db)).toEqual([]);
}
const wallet = async () => (await store.call('GET', '/store/v1/me/wallet')).json();
function disputeBody(type: 'created' | 'lost'): string {
  return JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    type: type === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_story',
        payment_intent: reference,
        amount: 5000,
        currency: 'usd',
        fee: 1500,
        reason: 'fraudulent',
        status: type === 'created' ? 'needs_response' : 'lost',
      },
    },
  });
}

describe('a store balance top-up charged back after part of it was spent', () => {
  it('step 1: the card top-up of 50 is confirmed and the automatic credit puts 48.50 on the balance', async () => {
    const { db } = await testDb();
    const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.code, 'card'));
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        number: 'INV-2026-0901',
        customerId: customer.id,
        kind: 'topup',
        amount: '50.0000',
        fee: '1.5000',
        netAmount: '48.5000',
        total: '50.0000',
        currency: 'USD',
        gatewayId: gateway!.id,
        checkoutUrl: 'https://pay.example/cs_story',
      })
      .returning();
    reference = `pi_${crypto.randomUUID()}`;
    const body = cardEvent('evt_story_paid', invoice!.number, { reference, amount: 5000 });
    expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
    clock.advance(10 * MINUTE);
    const job = t.app.get(PaymentAutoCredit, { strict: false });
    expect(await job.run(await job.due())).toMatchObject({ credited: 1 });
    expect(await wallet()).toMatchObject({ balance: '48.5000' });
    expect(await journalKinds()).toEqual(['deposit']);
    await booksClean();
  });

  it('step 2: the customer pays a checkout of 4.79 from the balance', async () => {
    const { token } = await openSignedInCheckout(store, world, customer.email);
    expect((await payFromBalance(store, token)).statusCode).toBe(201);
    expect(await wallet()).toMatchObject({ balance: '43.7100' });
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment']);
    await booksClean();
  });

  it('step 3: the gateway opens a dispute: the balance is on hold and cannot pay', async () => {
    expect((await hook(t, clock, 'disputes', 'card', disputeBody('created'))).statusCode).toBe(200);
    expect(await wallet()).toMatchObject({
      balance: '43.7100',
      available: '0.0000',
      frozen: { at: expect.any(String) },
    });
    const { token } = await openSignedInCheckout(store, world, customer.email);
    const refused = await payFromBalance(store, token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('WALLET_FROZEN');
    expect((await staff.get(`/admin/customers/${customer.id}/wallet`)).body).toMatchObject({ openDisputes: 1 });
  });

  it('step 4: the dispute is lost: the credit is taken back (below zero), the fee reversed, the dispute fee booked', async () => {
    expect((await hook(t, clock, 'disputes', 'card', disputeBody('lost'))).statusCode).toBe(200);
    // 43.71 − 48.50 = −4.79: what the customer spent of money the gateway took back.
    expect(await wallet()).toMatchObject({ balance: '-4.7900', available: '0.0000' });
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment', 'chargeback']);
    await booksClean();
  });

  it('step 5: staff collect the 4.79 with an audited credit, then lift the hold', async () => {
    const collected = await staff.post(
      `/admin/customers/${customer.id}/wallet/adjust`,
      { amount: '4.7900', direction: 'credit', reason: 'Collected by bank transfer' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(collected.status).toBe(200);
    const unfrozen = await staff.post(
      `/admin/customers/${customer.id}/wallet/unfreeze`,
      { reason: 'Debt collected' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(unfrozen.status).toBe(200);
    expect(await wallet()).toMatchObject({ balance: '0.0000', frozen: null });
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment', 'chargeback', 'adjustment']);
    await booksClean();
  });
});
