// End-to-end walk of a top-up chargeback (feature 21, beyond the map's 13 scenarios, plan § 5.6.9 and O11) on the real application, for the
// wallet of either kind of rank (decision 064). First story, a retail account: a card top-up is confirmed and credited by the automatic
// credit, the account spends part of it from its store balance, the gateway opens a dispute (the balance is put on hold and cannot pay), the
// dispute is lost (the credit is taken back, the balance goes below zero and stays frozen), staff collect it with an audited adjustment and
// lift the hold. Second story, a merchant rank: the same dispute holds the merchant wallet too, the next portal order is refused, and the
// loss takes the credit back. Each step asserts the journal kinds and that the books sum to zero and reconcile. The steps share one story,
// so the tests run in order.
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
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant, ledgerTotals } from '../support/money';
import { IMEIS, json, portalFor, walletOf } from '../support/orders';
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
  // Both audiences: the same card gateway credits the top-ups of a retail account and of a merchant.
  await insertGateway(t, db, { code: 'card', name: 'Card', driver: 'card', audience: 'both', apiBase: fake.url });
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
function disputeBody(type: 'created' | 'lost', dispute = 'dp_story', intent = reference): string {
  return JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    type: type === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed',
    data: {
      object: {
        id: dispute,
        payment_intent: intent,
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
        accountId: customer.id,
        // a retail account's top-up credits its store balance
        walletKind: 'customer_wallet',
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
    fake.paid(reference, { minor: 5000, reference: invoice!.number });
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
    expect((await staff.get(`/admin/clients/${customer.id}/wallet`)).body).toMatchObject({
      kind: 'store',
      openDisputes: 1,
    });
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
      `/admin/clients/${customer.id}/wallet/adjust`,
      { amount: '4.7900', direction: 'credit', reason: 'Collected by bank transfer' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(collected.status).toBe(200);
    const unfrozen = await staff.post(
      `/admin/clients/${customer.id}/wallet/unfreeze`,
      { reason: 'Debt collected' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(unfrozen.status).toBe(200);
    expect(await wallet()).toMatchObject({ balance: '0.0000', frozen: null });
    expect(await journalKinds()).toEqual(['deposit', 'b2c_payment', 'chargeback', 'adjustment']);
    await booksClean();
  });
});

describe('a merchant wallet top-up charged back before any of it was spent', () => {
  let merchantId = 0;
  let merchantReference = '';
  let manualServiceId = 0;
  /** How many journals existed before this story began: the first story's stay in the table. */
  let firstJournal = 0;
  const merchantJournalKinds = async () => (await journalKinds()).slice(firstJournal);

  it('step 1: the merchant card top-up of 50 is confirmed and the automatic credit puts 48.50 on the merchant wallet', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    merchantId = merchant.id;
    manualServiceId = await insertService(db, await insertCategory(db, { name: 'Manual desk' }), {
      name: 'Manual unlock',
      code: 'IMEI-MANUAL-DESK',
      fulfillment: 'manual',
      cost: '3.0000',
      effectiveCost: '3.0000',
      basePrice: '5.0000',
      minProfit: '0.5000',
      slaMinutes: 120,
    });
    firstJournal = (await journalKinds()).length;
    const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.code, 'card'));
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        number: 'INV-2026-0902',
        accountId: merchantId,
        // a merchant's top-up credits its merchant wallet; the merchant column still repeats the account until the contract release
        walletKind: 'client_wallet',
        legacyClientId: merchantId,
        kind: 'topup',
        amount: '50.0000',
        fee: '1.5000',
        netAmount: '48.5000',
        total: '50.0000',
        currency: 'USD',
        gatewayId: gateway!.id,
        checkoutUrl: 'https://pay.example/cs_merchant',
      })
      .returning();
    merchantReference = `pi_${crypto.randomUUID()}`;
    fake.paid(merchantReference, { minor: 5000, reference: invoice!.number });
    const body = cardEvent('evt_merchant_paid', invoice!.number, { reference: merchantReference, amount: 5000 });
    expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
    clock.advance(10 * MINUTE);
    const job = t.app.get(PaymentAutoCredit, { strict: false });
    expect(await job.run(await job.due())).toMatchObject({ credited: 1 });
    expect(await walletOf(db, merchantId)).toEqual({ wallet: '48.5000', hold: '0.0000' });
    expect(await merchantJournalKinds()).toEqual(['deposit']);
    await booksClean();
  });

  it('step 2: the gateway opens a dispute: the merchant wallet is on hold and the next portal order is refused', async () => {
    const opened = await hook(t, clock, 'disputes', 'card', disputeBody('created', 'dp_merchant', merchantReference));
    expect(opened.statusCode).toBe(200);
    expect((await staff.get(`/admin/clients/${merchantId}/wallet`)).body).toMatchObject({
      kind: 'merchant',
      balance: '48.5000',
      frozen: { at: expect.any(String) },
      openDisputes: 1,
    });
    const { db } = await testDb();
    const refused = await (
      await portalFor(t, merchantId)
    ).post('/client/orders', {
      serviceId: manualServiceId,
      imei: IMEIS[0],
    });
    expect(refused.statusCode).toBe(409);
    expect(json(refused)).toMatchObject({ code: 'WALLET_FROZEN' });
    // Nothing was placed and nothing was held: the wallet is as the credit left it.
    expect(await db.select().from(s.orders).where(eq(s.orders.accountId, merchantId))).toEqual([]);
    expect(await walletOf(db, merchantId)).toEqual({ wallet: '48.5000', hold: '0.0000' });
  });

  it('step 3: the dispute is lost: the credit is taken back from the merchant wallet, which stays on hold', async () => {
    expect(
      (await hook(t, clock, 'disputes', 'card', disputeBody('lost', 'dp_merchant', merchantReference))).statusCode,
    ).toBe(200);
    const { db } = await testDb();
    expect(await walletOf(db, merchantId)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    expect(await merchantJournalKinds()).toEqual(['deposit', 'chargeback']);
    expect((await staff.get(`/admin/clients/${merchantId}/wallet`)).body).toMatchObject({
      balance: '0.0000',
      frozen: { at: expect.any(String) },
      openDisputes: 0,
    });
    await booksClean();
  });

  it('step 4: staff lift the hold with an audited unfreeze and the merchant wallet is live again', async () => {
    const lifted = await staff.post(
      `/admin/clients/${merchantId}/wallet/unfreeze`,
      { reason: 'Dispute closed' },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(lifted.status).toBe(200);
    expect(lifted.body).toMatchObject({ kind: 'merchant', balance: '0.0000', frozen: null });
    expect(await merchantJournalKinds()).toEqual(['deposit', 'chargeback']);
    await booksClean();
  });
});
