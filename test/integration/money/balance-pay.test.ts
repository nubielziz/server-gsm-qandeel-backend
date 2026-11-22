// Integration tests of paying a checkout from the store balance (feature 21, plan § 5.6.6, route
// POST /store/v1/checkout-sessions/:token/balance-payment): the order at once with its journal, every refusal writing nothing, the replay,
// a double click, parallel checkouts on a balance that covers three, a card capture racing it, the guest and foreign checkouts, the hold,
// the switch, and the risk rules' hold and block.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, hook, json, openCheckout, pay, storefrontEvent } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { MINUTE, TestClock } from '../../support/clock';
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
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, orderRow, systemBalance } from '../../support/orders';
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

/** A customer with an account, signed in on its own address, with a balance. */
async function buyer(balance = '50', name = 'Daniel Rivera') {
  const customer = await makeCustomer(t, { name });
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  if (balance !== '0') await fundCustomer(db, customer.id, balance);
  return { customer, client };
}

/** The lines of one journal by its key: account kind and signed amount (debit above zero), sorted by kind. */
async function journal(key: string): Promise<Array<{ account: string; amount: string }>> {
  const result = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount
        from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key} order by a.kind`,
  );
  return result.rows;
}

const counts = async () => ({
  payments: (await db.select().from(s.payments).where(eq(s.payments.methodType, 'balance'))).length,
  orders: (await db.select().from(s.orders)).length,
});

describe('POST /store/v1/checkout-sessions/:token/balance-payment', () => {
  it('pays the checkout at once: the order, Dr wallet / Cr customer funds / Cr VAT, the receipt, the mail, the session paid', async () => {
    const { customer, client } = await buyer();
    const { token, session } = await openSignedInCheckout(client, world, customer.email);
    expect(session.balancePayable).toBe(true);

    const res = await payFromBalance(client, token, 'pay-1');
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = json(res);
    expect(body).toEqual({
      payment: {
        id: expect.any(Number),
        reference: `PAY-${body.payment.id}`,
        status: 'captured',
        method: 'balance',
        currency: 'GBP',
        amount: '3.8400',
        amountUsd: '4.7900',
      },
      order: { id: expect.any(Number), trackingToken: expect.any(String) },
      wallet: { balance: '45.2100', available: '45.2100' },
    });

    const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, body.payment.id));
    const invoiceId = payment!.invoiceId!;
    expect(payment).toMatchObject({
      purpose: 'order',
      methodType: 'balance',
      gatewayId: null,
      status: 'captured',
      customerId: customer.id,
      orderId: body.order.id,
      amount: '3.8400',
      currency: 'GBP',
      feeAmount: '0.0000',
      brand: 'Store balance',
      invoiceId: expect.any(Number),
    });
    expect(await journal(`payment:${payment!.id}:capture`)).toEqual([
      { account: 'customer_funds', amount: '-3.9900' },
      { account: 'customer_wallet', amount: '4.7900' },
      { account: 'vat_payable', amount: '-0.8000' },
    ]);
    const [receipt] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(receipt).toMatchObject({ status: 'paid', gatewayId: null, total: '3.8400', currency: 'GBP' });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('45.2100');
    expect(await systemBalance(db, 'customer_funds')).toBe('3.9900');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const order = await orderRow(db, body.order.id);
    expect(order).toMatchObject({ customerId: customer.id, publicToken: body.order.trackingToken });
    expect((await eventsOf(db, order.id)).find((event) => event.type === 'paid')?.data).toMatchObject({
      message: 'Payment of 3.8400 GBP received (Store balance)',
    });
    const [row] = await db.select().from(s.checkoutSessions);
    expect(row).toMatchObject({ status: 'paid', orderId: order.id });
    const mails = (await notificationRows(db)).filter((mail) => mail.event === 'order.received');
    expect(mails).toHaveLength(1);
  });

  it('answers a retry with the same key again without paying twice; a key /pay used on the checkout is refused', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const first = await payFromBalance(client, token, 'same-key');
    const again = await payFromBalance(client, token, 'same-key');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual(json(first));
    expect(await counts()).toEqual({ payments: 1, orders: 1 });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('45.2100');

    const other = await openSignedInCheckout(client, world, customer.email);
    expect((await pay(t, other.token, undefined, 'card-key')).statusCode).toBe(201);
    const reused = await payFromBalance(client, other.token, 'card-key');
    expect(reused.statusCode).toBe(409);
    expect(json(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a double click pays once: the same key twice at once replays, two keys at once leave one refused', async () => {
    const { customer, client } = await buyer();
    const one = await openSignedInCheckout(client, world, customer.email);
    const sameKey = await Promise.all([payFromBalance(client, one.token, 'k'), payFromBalance(client, one.token, 'k')]);
    expect(sameKey.map((res) => res.statusCode)).toEqual([201, 201]);
    expect(sameKey.filter((res) => res.headers['idempotency-replayed'] === 'true')).toHaveLength(1);

    const two = await openSignedInCheckout(client, world, customer.email);
    const twoKeys = await Promise.all([payFromBalance(client, two.token), payFromBalance(client, two.token)]);
    expect(twoKeys.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(json(twoKeys.find((res) => res.statusCode === 409)!).code).toBe('INVALID_TRANSITION');
    expect(await counts()).toEqual({ payments: 2, orders: 2 });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('40.4200');
  });

  it('ten checkouts paid at once on a balance that covers three: three orders, never below zero', async () => {
    const { customer, client } = await buyer('15');
    const tokens: string[] = [];
    for (let i = 0; i < 10; i += 1) tokens.push((await openSignedInCheckout(client, world, customer.email)).token);
    const answers = await Promise.all(tokens.map((token) => payFromBalance(client, token)));
    const statuses = answers.map((res) => res.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 402)).toHaveLength(7);
    for (const refused of answers.filter((res) => res.statusCode === 402)) {
      expect(json(refused).code).toBe('INSUFFICIENT_FUNDS');
    }
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('0.6300');
    expect(await counts()).toEqual({ payments: 3, orders: 3 });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a card confirmation that arrives after the balance paid is booked as a duplicate and refunded; one order', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const card = json(await pay(t, token, undefined, 'card-1')).payment;
    expect((await payFromBalance(client, token, 'balance-1')).statusCode).toBe(201);
    const event = storefrontEvent('evt_race', card.reference, { amount: card.amount, intent: 'pi_race' });
    expect((await hook(t, clock, 'payments', world.gateway.code, event)).statusCode).toBe(200);
    expect((await db.select().from(s.orders)).length).toBe(1);
    const [duplicate] = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, card.id));
    expect(duplicate).toMatchObject({ requestedByType: 'system' });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('45.2100');
  });

  it('refuses a request without a customer session (401), without its CSRF token, and without a key; nothing is written', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const guest = await payFromBalance(client, token, undefined, { cookies: false, csrf: false });
    expect(guest.statusCode).toBe(401);
    expect(json(guest).code).toBe('UNAUTHORIZED');
    const noCsrf = await payFromBalance(client, token, undefined, { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).code).toBe('CSRF_FAILED');
    const noKey = await payFromBalance(client, token, null);
    expect(noKey.statusCode).toBe(422);
    expect(await counts()).toEqual({ payments: 0, orders: 0 });
  });

  it("refuses another account's checkout and a checkout opened as a guest with the account's email (403)", async () => {
    const { customer, client } = await buyer();
    const other = await buyer('50', 'Other Buyer');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const foreign = await payFromBalance(other.client, token);
    expect(foreign.statusCode).toBe(403);
    expect(json(foreign)).toMatchObject({ code: 'FORBIDDEN', detail: 'This checkout belongs to another account.' });

    // A guest checkout typed with the account's email carries the account's id, but can never spend its balance (K2).
    const guest = await openCheckout(t, world, { email: customer.email });
    expect(guest.session.balancePayable).toBe(false);
    const [guestRow] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.token, guest.token));
    expect(guestRow!.customerId).toBe(customer.id);
    const refused = await payFromBalance(client, guest.token);
    expect(refused.statusCode).toBe(403);
    expect(json(refused).detail).toBe('Open the checkout while signed in to pay from your balance.');
    expect(await counts()).toEqual({ payments: 0, orders: 0 });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('50.0000');
  });

  it('refuses missing consents (422), an expired checkout and a paid one (409 INVALID_TRANSITION)', async () => {
    const { customer, client } = await buyer();
    const noConsent = await openSignedInCheckout(client, world, customer.email, { consent: false });
    const res = await payFromBalance(client, noConsent.token);
    expect(res.statusCode).toBe(422);
    expect(json(res).errors[0]).toMatchObject({ field: 'consent', code: 'required' });

    const paid = await openSignedInCheckout(client, world, customer.email);
    expect((await payFromBalance(client, paid.token)).statusCode).toBe(201);
    const twice = await payFromBalance(client, paid.token);
    expect(twice.statusCode).toBe(409);
    expect(json(twice)).toMatchObject({ code: 'INVALID_TRANSITION', detail: 'This checkout was already paid.' });

    const late = await openSignedInCheckout(client, world, customer.email);
    clock.advance(31 * MINUTE);
    const expired = await payFromBalance(client, late.token);
    expect(expired.statusCode).toBe(409);
    expect(json(expired).code).toBe('INVALID_TRANSITION');
    expect(await counts()).toEqual({ payments: 1, orders: 1 });
  });

  it('refuses a balance that does not cover the gross (402), a wallet on hold, and the switch off (409); nothing is written', async () => {
    const { customer, client } = await buyer('4.78');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const short = await payFromBalance(client, token);
    expect(short.statusCode).toBe(402);
    expect(json(short).code).toBe('INSUFFICIENT_FUNDS');

    await fundCustomer(db, customer.id, '10');
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: clock.now(), frozenReason: 'Review' })
      .where(eq(s.ledgerAccounts.id, (await customerWalletRow(db, customer.id))!.id));
    const frozen = await payFromBalance(client, token);
    expect(frozen.statusCode).toBe(409);
    expect(json(frozen).code).toBe('WALLET_FROZEN');

    await db.update(s.ledgerAccounts).set({ frozenAt: null, frozenReason: '' });
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    const off = await payFromBalance(client, token);
    expect(off.statusCode).toBe(409);
    expect(json(off).code).toBe('WALLET_DISABLED');
    const shown = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${token}`,
      remoteAddress: freshClientIp(),
    });
    expect(json(shown).balancePayable).toBe(false);
    expect(await counts()).toEqual({ payments: 0, orders: 0 });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('14.7800');
  });
});

describe('the risk rules on a balance payment', () => {
  let risk: AdminApi;
  beforeEach(async () => {
    risk = await adminWith(t, ['risk:*'], { name: 'Rami K.' });
  });

  /** Saves the rules with the given numbers changed, as the console sends them (the whole set). */
  async function setRules(values: Record<string, number>): Promise<void> {
    const current: Array<{ id: string; on: boolean; value: number | null }> = (await risk.get('/admin/risk/rules')).body
      .rules;
    const rules = current.map(({ id, on, value }) => ({ id, on, value: id in values ? values[id]! : value }));
    expect((await risk.put('/admin/risk/rules', { rules })).status).toBe(200);
  }

  it('review: the order is placed held, the balance is taken, the queue says balance', async () => {
    // Any first order above 1 USD scores 18; review from 10.
    await setRules({ reviewFirstOrderAbove: 1, reviewThreshold: 10 });
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    expect(await orderRow(db, json(res).order.id)).toMatchObject({ status: 'pending', dispatchState: 'held' });
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('45.2100');
    const queue = await risk.get('/admin/risk/queue');
    expect(queue.body.held[0]).toMatchObject({ paymentMethod: 'balance' });
  });

  it('block: the order is refunded to the balance at once, with no gateway job, and the buyer hears it went back to the balance', async () => {
    // Any first order above 1 USD scores 18; block from 15.
    await setRules({ reviewFirstOrderAbove: 1, reviewThreshold: 5, blockThreshold: 15 });
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    expect(json(res).wallet).toEqual({ balance: '50.0000', available: '50.0000' });
    const orderId = json(res).order.id;
    expect((await orderRow(db, orderId)).status).toBe('rejected');
    const [refund] = await db.select().from(s.refunds);
    expect(refund).toMatchObject({ status: 'completed', method: 'original', requestedByType: 'system' });
    expect(await journal(`order:${orderId}:refund`)).toEqual([
      { account: 'customer_funds', amount: '3.9900' },
      { account: 'customer_wallet', amount: '-4.7900' },
      { account: 'vat_payable', amount: '0.8000' },
    ]);
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'refund.process'))).toHaveLength(0);
    const mails = (await notificationRows(db)).map((mail) => mail.event);
    expect(mails).toContain('wallet.order_refunded');
    expect(mails).not.toContain('order.failed');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});
