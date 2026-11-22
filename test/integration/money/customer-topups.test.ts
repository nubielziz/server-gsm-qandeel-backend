// Integration tests of the store balance top-ups (feature 21, plan § 7.1 routes 3 to 8): the methods, a new top-up (manual and automatic),
// every limit with the clock, the Idempotency-Key replay and reuse, parallel creates under the limits, the receipt (retry, conflicts,
// ownership, reference), the cancel, and another customer's top-up never visible. Decision 049: one receipt (or a copy of its bytes) backs
// one live payment, whoever uploaded it; a card top-up asks for 3-D Secure under the shop's policy.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  insertGateway,
  insertInvoiceRow,
  insertPendingPayment,
  insertProofFile,
} from '../../support/billing';
import { TestClock } from '../../support/clock';
import { fundCustomer, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { PORTAL_ORIGIN } from '../../support/merchant-portal';
import { insertWalletMerchant } from '../../support/money';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';
import { portalFor } from '../../support/webhooks';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let fake: FakeGateway;
let cliq: number;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule],
    env: { SHOP_ORIGINS: `${STORE_ORIGIN},${PORTAL_ORIGIN}` },
  });
  fake = new FakeGateway();
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  fake.failWith = undefined;
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  cliq = await insertGateway(t, db, {
    code: 'cliq',
    driver: 'manual',
    name: 'CliQ transfer',
    audience: 'b2c',
    isManual: true,
    instructions: 'Send it by CliQ to GSMSHOP.',
  });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function signedIn() {
  const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  return { customer, store };
}

const create = (store: StoreClient, body: unknown, key: string = crypto.randomUUID()) =>
  store.call('POST', '/store/v1/me/wallet/top-ups', body, { headers: { 'idempotency-key': key } });
const codeOf = (res: { json(): { code?: string; errors?: Array<{ code: string }> } }) => {
  const body = res.json();
  return body.errors?.[0]?.code ?? body.code;
};

describe('GET /store/v1/me/wallet/top-up-methods', () => {
  it('lists manual B2C methods with the effective limits; card ones only while card top-ups are on', async () => {
    const { db } = await testDb();
    await insertGateway(t, db, {
      code: 'b2b-bank',
      driver: 'manual',
      isManual: true,
      audience: 'b2b',
      name: 'B2B bank',
    });
    await insertGateway(t, db, {
      code: 'card',
      driver: 'card',
      audience: 'b2c',
      name: 'Card',
      minAmount: '10',
      maxAmount: '200',
      apiBase: fake.url,
    });
    const { store } = await signedIn();
    const res = await store.call('GET', '/store/v1/me/wallet/top-up-methods');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: cliq,
        code: 'cliq',
        kind: 'manual',
        methodType: 'bank',
        minAmount: '5.0000',
        maxAmount: '500.0000',
        instructions: 'Send it by CliQ to GSMSHOP.',
      }),
    ]);
    await walletSettings(t, db, { 'wallet.customer.card_topups': true });
    const both = (await store.call('GET', '/store/v1/me/wallet/top-up-methods')).json();
    expect(both.map((row: { code: string }) => row.code)).toEqual(['card', 'cliq']);
    expect(both[0]).toMatchObject({ kind: 'automatic', minAmount: '10.0000', maxAmount: '200.0000' });
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    expect((await store.call('GET', '/store/v1/me/wallet/top-up-methods')).json()).toEqual([]);
  });
});

describe('POST /store/v1/me/wallet/top-ups', () => {
  it('creates a manual top-up with its instructions, replays the same key and refuses it with another body', async () => {
    const { customer, store } = await signedIn();
    const first = await create(store, { amount: '50', gatewayId: cliq }, 'attempt-1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const topUp = first.json();
    expect(topUp).toMatchObject({
      status: 'awaiting_payment',
      amount: '50.0000',
      fee: '0.0000',
      netAmount: '50.0000',
      currency: 'USD',
      method: { id: cliq, code: 'cliq', name: 'CliQ transfer', kind: 'manual', methodType: 'bank' },
      reference: null,
      receiptUploaded: false,
      instructions: 'Send it by CliQ to GSMSHOP.',
    });
    expect(topUp.number).toMatch(/^INV-2026-/);
    const again = await create(store, { amount: '50.00', gatewayId: cliq }, 'attempt-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json().id).toBe(topUp.id);
    const reused = await create(store, { amount: '60', gatewayId: cliq }, 'attempt-1');
    expect(reused.statusCode).toBe(409);
    expect(codeOf(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    const { db } = await testDb();
    const rows = await db.select().from(s.invoices).where(eq(s.invoices.customerId, customer.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'topup', taxRate: '0.0000', idempotencyKey: 'attempt-1', clientId: null });
  });

  it('refuses without a key, while switched off, a method it may not use, and a bad amount', async () => {
    const { db } = await testDb();
    const b2b = await insertGateway(t, db, { code: 'b2b', driver: 'manual', isManual: true, audience: 'b2b' });
    const { store } = await signedIn();
    expect(
      (await store.call('POST', '/store/v1/me/wallet/top-ups', { amount: '50', gatewayId: cliq })).statusCode,
    ).toBe(422);
    expect(codeOf(await create(store, { amount: '50', gatewayId: b2b }))).toBe('unavailable');
    expect(codeOf(await create(store, { amount: '50', gatewayId: 99999 }))).toBe('unavailable');
    expect(codeOf(await create(store, { amount: '5.123456', gatewayId: cliq }))).toBe('format');
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    expect(codeOf(await create(store, { amount: '50', gatewayId: cliq }))).toBe('WALLET_DISABLED');
    expect(
      (
        await new StoreClient(t).call(
          'POST',
          '/store/v1/me/wallet/top-ups',
          {},
          { headers: { 'idempotency-key': 'x' } },
        )
      ).statusCode,
    ).toBe(401);
  });

  it('applies the per-top-up, unpaid, daily and balance limits, with the 24 hour window on the clock', async () => {
    const { db } = await testDb();
    const { customer, store } = await signedIn();
    expect(codeOf(await create(store, { amount: '4.99', gatewayId: cliq }))).toBe('min');
    expect(codeOf(await create(store, { amount: '500.01', gatewayId: cliq }))).toBe('max');
    await walletSettings(t, db, { 'wallet.customer.topups_per_day': 2, 'wallet.customer.topup_amount_per_day': 100 });
    expect((await create(store, { amount: '60', gatewayId: cliq })).statusCode).toBe(201);
    expect(codeOf(await create(store, { amount: '50', gatewayId: cliq }))).toBe('daily_amount');
    expect((await create(store, { amount: '40', gatewayId: cliq })).statusCode).toBe(201);
    expect(codeOf(await create(store, { amount: '5', gatewayId: cliq }))).toBe('daily_count');
    clock.advance(24 * 3_600_000 + 1000);
    expect((await create(store, { amount: '5', gatewayId: cliq })).statusCode).toBe(201);
    const fourth = await create(store, { amount: '5', gatewayId: cliq });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toMatchObject({
      code: 'CONFLICT',
      detail: 'You have 3 unpaid top-ups. Pay or cancel one first.',
    });

    const other = await signedIn();
    await fundCustomer(db, other.customer.id, '960');
    expect(codeOf(await create(other.store, { amount: '41', gatewayId: cliq }))).toBe('max_balance');
    expect((await create(other.store, { amount: '40', gatewayId: cliq })).statusCode).toBe(201);
    void customer;
  });

  it('lets only as many parallel creates through as the limits allow', async () => {
    const { db } = await testDb();
    await walletSettings(t, db, { 'wallet.customer.topups_per_day': 2 });
    const { customer, store } = await signedIn();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => create(store, { amount: '10', gatewayId: cliq })),
    );
    expect(results.filter((res) => res.statusCode === 201)).toHaveLength(2);
    expect(results.filter((res) => res.statusCode === 422).every((res) => codeOf(res) === 'daily_count')).toBe(true);
    const rows = await db.select().from(s.invoices).where(eq(s.invoices.customerId, customer.id));
    expect(rows).toHaveLength(2);
  });

  it('opens the hosted page of an automatic method, voids the top-up when the gateway fails, and refuses it while frozen', async () => {
    const { db } = await testDb();
    await walletSettings(t, db, { 'wallet.customer.card_topups': true });
    const card = await insertGateway(t, db, {
      code: 'card',
      driver: 'card',
      audience: 'b2c',
      name: 'Card',
      apiBase: fake.url,
    });
    const { customer, store } = await signedIn();
    const opened = await create(store, { amount: '25', gatewayId: card }, 'card-1');
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ status: 'awaiting_payment', method: { kind: 'automatic' } });
    expect(opened.json().paymentUrl).toMatch(/^https:\/\/pay\.example\//);

    fake.failWith = 500;
    const failed = await create(store, { amount: '26', gatewayId: card }, 'card-2');
    expect(failed.statusCode).toBe(502);
    expect(codeOf(failed)).toBe('GATEWAY_ERROR');
    const voided = await db.select().from(s.invoices).where(eq(s.invoices.amount, '26.0000'));
    expect(voided[0]).toMatchObject({ status: 'void', idempotencyKey: null });
    fake.failWith = undefined;
    expect((await create(store, { amount: '26', gatewayId: card }, 'card-2')).statusCode).toBe(201);

    await db.insert(s.ledgerAccounts).values({
      kind: 'customer_wallet',
      ownerType: 'customer',
      ownerId: customer.id,
      currency: 'USD',
      frozenAt: new Date(),
    });
    expect(codeOf(await create(store, { amount: '27', gatewayId: card }))).toBe('WALLET_FROZEN');
    // A manual top-up is still allowed while frozen (money in is safe, P1).
    expect((await create(store, { amount: '27', gatewayId: cliq })).statusCode).toBe(201);
  });

  it('refuses an amount a card page cannot charge exactly before a top-up is reserved, and takes a manual one as typed', async () => {
    const { db } = await testDb();
    await walletSettings(t, db, { 'wallet.customer.card_topups': true });
    const card = await insertGateway(t, db, {
      code: 'card',
      driver: 'card',
      audience: 'b2c',
      name: 'Card',
      apiBase: fake.url,
    });
    const { customer, store } = await signedIn();
    const sessions = () => fake.requests.filter((request) => request.path === '/v1/checkout/sessions');
    const before = sessions().length;
    for (const amount of ['25.005', '25.0049']) {
      const res = await create(store, { amount, gatewayId: card }, `card-${amount}`);
      expect(res.statusCode, amount).toBe(422);
      expect(res.json().errors[0], amount).toMatchObject({ field: 'amount', code: 'not_chargeable' });
    }
    expect(sessions()).toHaveLength(before);
    expect(await db.select().from(s.invoices).where(eq(s.invoices.customerId, customer.id))).toHaveLength(0);

    // The same key is free again: a refusal reserved nothing.
    const exact = await create(store, { amount: '25.01', gatewayId: card }, 'card-25.005');
    expect(exact.statusCode).toBe(201);
    expect(sessions()).toHaveLength(before + 1);
    expect(new URLSearchParams(sessions().at(-1)!.body).get('line_items[0][price_data][unit_amount]')).toBe('2501');
    expect((await create(store, { amount: '25.1000', gatewayId: card })).statusCode).toBe(201);

    const manual = await create(store, { amount: '25.005', gatewayId: cliq });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().amount).toBe('25.0050');
  });

  it("asks for 3-D Secure on a card top-up under the shop's policy (decision 049)", async () => {
    const { db } = await testDb();
    await walletSettings(t, db, { 'wallet.customer.card_topups': true });
    const card = await insertGateway(t, db, {
      code: 'card',
      driver: 'card',
      audience: 'b2c',
      name: 'Card',
      apiBase: fake.url,
      supports3ds: true,
    });
    const { store } = await signedIn();
    const threeDs = () => {
      const checkouts = fake.requests.filter((request) => request.path === '/v1/checkout/sessions');
      return new URLSearchParams(checkouts.at(-1)!.body).get('payment_method_options[card][request_three_d_secure]');
    };
    expect((await create(store, { amount: '25', gatewayId: card })).statusCode).toBe(201);
    expect(threeDs()).toBe('any');
    await walletSettings(t, db, { 'wallet.customer.card_topups': true, require3ds: false });
    expect((await create(store, { amount: '26', gatewayId: card })).statusCode).toBe(201);
    expect(threeDs()).toBeNull();
  });
});

describe('the receipt, the cancel and the reads', () => {
  async function openTopUp() {
    const { customer, store } = await signedIn();
    const topUp = (await create(store, { amount: '50', gatewayId: cliq })).json();
    const { db } = await testDb();
    const fileId = await insertProofFile(db, customer.id, { ownerType: 'customer' });
    return { customer, store, topUp, fileId, db };
  }
  const receipt = (store: StoreClient, id: number, body: unknown) =>
    store.call('POST', `/store/v1/me/wallet/top-ups/${id}/receipt`, body, {
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
  const cancel = (store: StoreClient, id: number) =>
    store.call('POST', `/store/v1/me/wallet/top-ups/${id}/cancel`, undefined, {
      headers: { 'idempotency-key': crypto.randomUUID() },
    });

  it('attaches a receipt once (a retry answers the same), and puts the top-up in review', async () => {
    const { customer, store, topUp, fileId, db } = await openTopUp();
    const res = await receipt(store, topUp.id, { fileId, reference: ' CLIQ-1 ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'in_review', reference: 'CLIQ1', receiptUploaded: true });
    expect(res.json().instructions).toBeUndefined();
    expect((await receipt(store, topUp.id, { fileId, reference: 'CLIQ-1' })).statusCode).toBe(201);
    const [payment, ...more] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, topUp.id));
    expect(more).toHaveLength(0);
    expect(payment).toMatchObject({
      purpose: 'topup',
      status: 'pending',
      customerId: customer.id,
      methodType: 'bank',
      receiptFileId: fileId,
      amount: '50.0000',
    });
    const otherFile = await insertProofFile(db, customer.id, { ownerType: 'customer' });
    expect(codeOf(await receipt(store, topUp.id, { fileId: otherFile }))).toBe('CONFLICT');
    expect(codeOf(await cancel(store, topUp.id))).toBe('CONFLICT');
  });

  it('refuses a file that is not the customer’s, a reference already used, and another customer’s top-up', async () => {
    const { customer, store, topUp, db } = await openTopUp();
    const merchantFile = await insertProofFile(db, customer.id);
    expect(codeOf(await receipt(store, topUp.id, { fileId: merchantFile }))).toBe('invalid');
    const text = await insertProofFile(db, customer.id, { ownerType: 'customer', mime: 'text/plain' });
    expect(codeOf(await receipt(store, topUp.id, { fileId: text }))).toBe('invalid');
    const other = await openTopUp();
    expect((await receipt(other.store, other.topUp.id, { fileId: other.fileId, reference: 'REF-1' })).statusCode).toBe(
      201,
    );
    const mine = await insertProofFile(db, customer.id, { ownerType: 'customer' });
    expect(codeOf(await receipt(store, topUp.id, { fileId: mine, reference: 'REF-1' }))).toBe('taken');
    expect((await receipt(store, other.topUp.id, { fileId: mine })).statusCode).toBe(404);
    expect((await store.call('GET', `/store/v1/me/wallet/top-ups/${other.topUp.id}`)).statusCode).toBe(404);
  });

  it("refuses a receipt that backs another live payment, the customer's own or anyone's (decision 049)", async () => {
    const { customer, store, topUp, fileId, db } = await openTopUp();
    const second = (await create(store, { amount: '60', gatewayId: cliq })).json();
    const third = (await create(store, { amount: '70', gatewayId: cliq })).json();
    expect((await receipt(store, topUp.id, { fileId })).statusCode).toBe(201);
    const reused = await receipt(store, second.id, { fileId });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().errors[0]).toMatchObject({ field: 'fileId', code: 'taken' });
    // A merchant's receipt waiting for review: the customer's copy of the same bytes is the same receipt.
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const bank = await insertGateway(t, db, { code: 'b2b-bank', driver: 'manual', isManual: true, audience: 'b2b' });
    const merchantFile = await insertProofFile(db, merchant.id);
    const [stored] = await db.select().from(s.files).where(eq(s.files.id, merchantFile));
    await insertPendingPayment(db, await insertInvoiceRow(db, merchant.id, { gatewayId: bank }), bank, {
      receiptFileId: merchantFile,
    });
    const copy = await insertProofFile(db, customer.id, { ownerType: 'customer', sha256: stored!.sha256 });
    expect(codeOf(await receipt(store, third.id, { fileId: copy }))).toBe('taken');
    // Sending the first receipt again to its own top-up is still a retry.
    expect((await receipt(store, topUp.id, { fileId })).statusCode).toBe(201);
    expect(await db.select().from(s.payments).where(eq(s.payments.customerId, customer.id))).toHaveLength(1);
  });

  it('judges the same bytes attached by a merchant and by a customer at the same moment one after the other (decision 049)', async () => {
    const { db } = await testDb();
    const bank = await insertGateway(t, db, { code: 'b2b-bank', driver: 'manual', isManual: true, audience: 'b2b' });
    // The two uploads lock different invoice rows (and the merchant's top-up lock is the merchant's own): only the content lock orders them. Several
    // rounds, each with a new merchant, a new customer and a new content.
    for (let round = 0; round < 6; round += 1) {
      const merchant = await insertWalletMerchant(db, { name: `Zain Mobile Hub ${round}` });
      const portal = await portalFor(t, merchant.id);
      const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId: bank });
      const merchantFile = await insertProofFile(db, merchant.id);
      const [stored] = await db.select().from(s.files).where(eq(s.files.id, merchantFile));
      const { customer, store, topUp } = await openTopUp();
      const customerFile = await insertProofFile(db, customer.id, { ownerType: 'customer', sha256: stored!.sha256 });
      const [byMerchant, byCustomer] = await Promise.all([
        portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId: merchantFile }),
        receipt(store, topUp.id, { fileId: customerFile }),
      ]);
      expect([byMerchant.status, byCustomer.statusCode].sort()).toEqual([201, 422]);
      const refused = byMerchant.status === 422 ? byMerchant.body : byCustomer.json();
      expect(refused.errors[0]).toMatchObject({ field: 'fileId', code: 'taken' });
      const live = await db
        .select({ id: s.payments.id })
        .from(s.payments)
        .innerJoin(s.files, eq(s.files.id, s.payments.receiptFileId))
        .where(and(eq(s.files.sha256, stored!.sha256), inArray(s.payments.status, ['pending', 'approved'])));
      expect(live).toHaveLength(1);
    }
  });

  it('cancels a manual top-up without a receipt, twice the same; the list and the read show it', async () => {
    const { store, topUp } = await openTopUp();
    const first = await cancel(store, topUp.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'cancelled' });
    expect((await cancel(store, topUp.id)).json().status).toBe('cancelled');
    const one = await store.call('GET', `/store/v1/me/wallet/top-ups/${topUp.id}`);
    expect(one.json()).toMatchObject({ id: topUp.id, status: 'cancelled' });
    const list = await store.call('GET', '/store/v1/me/wallet/top-ups');
    expect(list.headers['x-total-count']).toBe('1');
    expect(list.json()[0]).toMatchObject({ id: topUp.id, status: 'cancelled' });
    expect(list.json()[0].instructions).toBeUndefined();
  });
});
