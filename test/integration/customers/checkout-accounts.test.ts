// Integration tests of the checkout under the one account type (decision 064): who a checkout belongs to
// (the signed-in retail account, or the guest row of the typed email and never the login account of that email), what a merchant rank
// may not do at the shop's door, the refusal of a login row that may not act, the consents of a checkout (subject 'account'), the
// rank re-check of the balance payment, the capture that never refuses, the `open_checkout` blocker of the rank change and the customers
// participant of the guest claim (NOWAIT). Each case fails without its change. These need the application wired.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { GuestClaimBusy, GuestClaimParticipants } from '@src/modules/identity';
import { RankChangeGuards, RefundProcessModule } from '@src/modules/money';
import { ensureMerchantGroup, makeAccount } from '../../support/accounts';
import { openAccountSession } from '../../support/account-sessions';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  B2cGateway,
  type B2cWorld,
  STORE_RETURN_URL,
  b2cWorld,
  hook,
  json,
  openCheckout,
  pay,
  storefrontEvent,
} from '../../support/b2c';
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
import { freshClientIp } from '../../support/pipeline-routes';
import { insertBlock } from '../../support/risk';
import { TURNSTILE_HEADERS } from '../../support/storefront';
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
  await insertWalletTemplates(db);
});

const OPEN_URL = '/store/v1/checkout-sessions';
const ALL_CONSENTS = [
  { purpose: 'terms', granted: true },
  { purpose: 'privacy', granted: true },
  { purpose: 'withdrawal_waiver', granted: true },
];
const NEUTRAL = 'This account cannot start a new order. Contact support.';

const payloadOf = (email: string) => ({
  serviceId: world.icloud.serviceId,
  email,
  country: 'GB',
  currency: 'GBP',
  imei: '353890110000004',
});

/** A signed-out open: the request of a visitor without a cookie. */
const openAsGuest = (email: string) =>
  t.app.inject({
    method: 'POST',
    url: OPEN_URL,
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: payloadOf(email) as never,
  });

/** The request of a browser that holds the session of a merchant-rank account (cookie and CSRF token as sign-in leaves them). */
async function asMerchant(path: string, payload: unknown, extraHeaders: Readonly<Record<string, string>> = {}) {
  const merchant = await makeAccount(t, { rank: 'merchant' });
  const session = await openAccountSession(t, merchant.id);
  const res = await t.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'user-agent': 'Mozilla/5.0 (test)',
      origin: STORE_ORIGIN,
      ...TURNSTILE_HEADERS,
      cookie: session.browserCookie,
      'x-csrf-token': session.csrf,
      ...extraHeaders,
    },
    remoteAddress: freshClientIp(),
    payload: payload as never,
  });
  return { merchant, res };
}

/** A retail account signed in on the shop, with the client that holds its cookies and CSRF token. */
async function signedIn(balance = '0') {
  const customer = await makeCustomer(t);
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  if (balance !== '0') await fundCustomer(db, customer.id, balance);
  return { customer, client };
}

/** A staff move of an account to a merchant rank, made straight in the table (the rank change use case is the money module's). */
async function moveToMerchantRank(accountId: number): Promise<void> {
  await db
    .update(s.clients)
    .set({ groupId: await ensureMerchantGroup(db) })
    .where(eq(s.clients.id, accountId));
}

const counts = async () => ({
  accounts: (await db.select().from(s.clients)).length,
  sessions: (await db.select().from(s.checkoutSessions)).length,
  consents: (await db.select().from(s.consentRecords)).length,
});

describe('POST /store/v1/checkout-sessions of a merchant rank', () => {
  it('is refused with RANK_NOT_ALLOWED when the request carries the merchant session, and nothing is written', async () => {
    const { merchant, res } = await asMerchant(OPEN_URL, payloadOf('sam@mail.example'));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'RANK_NOT_ALLOWED', detail: 'Your account orders from its price list.' });
    // No session, and no guest row for the typed email either: the merchant row is the only account there is.
    expect(await db.select().from(s.checkoutSessions)).toEqual([]);
    expect((await db.select().from(s.clients)).map((row) => row.id)).toEqual([merchant.id]);
  });

  it('is refused for the consents of a checkout too: a merchant session never records anything', async () => {
    const { token } = await openCheckout(t, world, { consent: false });
    const { res } = await asMerchant(`${OPEN_URL}/${token}/consents`, { consents: ALL_CONSENTS });
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('RANK_NOT_ALLOWED');
    expect(await db.select().from(s.consentRecords)).toEqual([]);
  });

  it('is refused at the pay step as at the consents step: a merchant session starts no payment, and nothing is written', async () => {
    const { token } = await openCheckout(t, world);
    const body = { gateway: 'card-b2c', returnUrl: STORE_RETURN_URL };
    const { res } = await asMerchant(`${OPEN_URL}/${token}/pay`, body, { 'idempotency-key': 'pay-key' });
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'RANK_NOT_ALLOWED', detail: 'Your account orders from its price list.' });
    expect(await db.select().from(s.payments)).toEqual([]);
    // The token is the credential: the same request without the merchant session starts the payment.
    expect((await pay(t, token, body, 'pay-key')).statusCode).toBe(201);
  });
});

describe('a signed-out checkout never attaches to a login account', () => {
  it('typed with the email of a merchant: a guest row of its own, the retail price, no balance payment, nothing on the merchant', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const res = await openAsGuest(merchant.email);
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      balancePayable: false,
      amounts: { usd: { net: '3.9900', tax: '0.8000', gross: '4.7900' } },
    });
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session?.accountId).not.toBe(merchant.id);
    expect(session).toMatchObject({ openedSignedIn: false, email: merchant.email });
    const [guest] = await db.select().from(s.clients).where(eq(s.clients.id, session!.accountId!));
    expect(guest).toMatchObject({ email: merchant.email, hasAccount: false, status: 'active' });
    // The merchant row is as it was made: the same login, the same rank, nothing written to it.
    const [row] = await db.select().from(s.clients).where(eq(s.clients.id, merchant.id));
    expect(row).toMatchObject({ hasAccount: true, groupId: merchant.groupId });
    expect(row?.updatedAt.toISOString()).toBe(merchant.row.updatedAt.toISOString());
  });

  it('typed with the email of a retail account that is not signed in: the same, a guest row of its own', async () => {
    const customer = await makeCustomer(t);
    expect((await openAsGuest(customer.email)).statusCode).toBe(201);
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session?.accountId).not.toBe(customer.id);
    expect(session?.openedSignedIn).toBe(false);
    expect((await db.select().from(s.clients).where(eq(s.clients.id, session!.accountId!)))[0]).toMatchObject({
      email: customer.email,
      hasAccount: false,
    });
    // Its consents belong to the guest row: none lands on the account.
    const { token } = json(await openAsGuest(customer.email));
    const consent = await t.app.inject({
      method: 'POST',
      url: `${OPEN_URL}/${token}/consents`,
      headers: { 'user-agent': 'Mozilla/5.0 (test)' },
      remoteAddress: freshClientIp(),
      payload: { consents: ALL_CONSENTS } as never,
    });
    expect(consent.statusCode).toBe(201);
    const rows = await db.select().from(s.consentRecords);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.subjectType === 'account' && row.subjectId === session!.accountId)).toBe(true);
    expect(rows.some((row) => row.subjectId === customer.id)).toBe(false);
  });

  it('is refused like a blocklist hit, with no guest row, when the login row of the email may not act', async () => {
    await insertBlock(t, db, 'email', 'fraud@mail.example');
    const blocklistAnswer = json(await openAsGuest('fraud@mail.example'));
    expect(blocklistAnswer).toMatchObject({ code: 'ACCOUNT_SUSPENDED', detail: NEUTRAL });
    const wordsOf = (answer: { code: string; detail: string; title: string }) => ({
      code: answer.code,
      detail: answer.detail,
      title: answer.title,
    });
    const rows = [
      await makeCustomer(t, { email: 'suspended-retail@mail.example', status: 'suspended' }),
      await makeAccount(t, { rank: 'merchant', email: 'suspended-merchant@mail.example', status: 'suspended' }),
      await makeCustomer(t, { email: 'blocked-retail@mail.example', status: 'blocked' }),
      await makeCustomer(t, {
        email: 'erased@mail.example',
        status: 'anonymized',
        anonymizedAt: new Date('2026-11-01T00:00:00.000Z'),
      }),
    ];
    const before = await counts();
    for (const row of rows) {
      // Whatever the case of the typed address, the answer is the blocklist answer, word for word.
      const res = await openAsGuest(row.email.toUpperCase());
      expect(res.statusCode, row.email).toBe(403);
      expect(wordsOf(json(res)), row.email).toEqual(wordsOf(blocklistAnswer));
    }
    // No guest row was made for any of them, and no session.
    expect(await counts()).toEqual(before);
    expect(await db.select().from(s.checkoutSessions)).toEqual([]);
  });

  it('is accepted for the guest row of an email whose login row is active, and a second open reuses that guest row', async () => {
    const customer = await makeCustomer(t);
    expect((await openAsGuest(customer.email)).statusCode).toBe(201);
    expect((await openAsGuest(customer.email.toUpperCase())).statusCode).toBe(201);
    const sessions = await db.select().from(s.checkoutSessions);
    expect(new Set(sessions.map((row) => row.accountId)).size).toBe(1);
    expect((await db.select().from(s.clients)).filter((row) => row.email === customer.email)).toHaveLength(2);
  });
});

describe('the consents of a checkout', () => {
  it('carry the subject (account, id) of the signed-in account that opened it', async () => {
    const { customer, client } = await signedIn();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const rows = await db.select().from(s.consentRecords);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.subjectType === 'account' && row.subjectId === customer.id)).toBe(true);
    expect(token).toBeTruthy();
  });

  it('carry the guest row of a signed-out checkout, and the guest row is never made by the consent route', async () => {
    const { token } = await openCheckout(t, world, { email: 'visitor@mail.example' });
    const [guest] = await db.select().from(s.clients).where(eq(s.clients.email, 'visitor@mail.example'));
    expect(guest).toMatchObject({ hasAccount: false });
    const rows = await db.select().from(s.consentRecords).orderBy(s.consentRecords.id);
    expect(rows.map((row) => [row.subjectType, row.subjectId])).toEqual([
      ['account', guest!.id],
      ['account', guest!.id],
      ['account', guest!.id],
    ]);
    // A session that lost its account opens nothing: a link without a buyer is not valid.
    await db
      .update(s.checkoutSessions)
      .set({ accountId: null })
      .where(sql`true`);
    const res = await t.app.inject({
      method: 'POST',
      url: `${OPEN_URL}/${token}/consents`,
      headers: { 'user-agent': 'Mozilla/5.0 (test)' },
      remoteAddress: freshClientIp(),
      payload: { consents: [{ purpose: 'terms', granted: false }] } as never,
    });
    expect(res.statusCode).toBe(404);
    expect(await db.select().from(s.consentRecords)).toHaveLength(3);
  });
});

describe('the token of a checkout and the account behind it', () => {
  it('opens nothing once the account (or guest row) behind it was anonymized', async () => {
    const { token } = await openCheckout(t, world, { email: 'visitor@mail.example' });
    const show = () => t.app.inject({ method: 'GET', url: `${OPEN_URL}/${token}`, remoteAddress: freshClientIp() });
    expect((await show()).statusCode).toBe(200);
    await db
      .update(s.clients)
      .set({ status: 'anonymized', anonymizedAt: new Date('2026-11-10T12:00:00.000Z') })
      .where(eq(s.clients.email, 'visitor@mail.example'));
    expect((await show()).statusCode).toBe(404);
  });

  it('is refused at the card pay step when the account behind it may no longer act, and nothing starts', async () => {
    const { token } = await openCheckout(t, world, { email: 'visitor@mail.example' });
    await db.update(s.clients).set({ status: 'blocked' }).where(eq(s.clients.email, 'visitor@mail.example'));
    const res = await pay(t, token, undefined, 'blocked-key');
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('ACCOUNT_SUSPENDED');
    expect(await db.select().from(s.payments)).toEqual([]);
  });

  it("starts a card payment as the checkout's account", async () => {
    const { customer, client } = await signedIn();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const started = json(await pay(t, token, undefined, 'card-key'));
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, started.payment.id));
    expect(payment).toMatchObject({ accountId: customer.id });
  });
});

describe('the balance payment and the rank of the account (decision 064)', () => {
  it('refuses 403 RANK_NOT_ALLOWED after the account moved to a merchant rank, and pays nothing', async () => {
    const { customer, client } = await signedIn('50');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    // The staff move lands in the table while the session of the browser still says retail: the use case reads the rank again
    // under the account row lock, so nothing is paid from a wallet the account no longer uses.
    await moveToMerchantRank(customer.id);
    const res = await payFromBalance(client, token, 'after-move');
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('RANK_NOT_ALLOWED');
    expect(await db.select().from(s.payments)).toEqual([]);
    expect(await db.select().from(s.orders)).toEqual([]);
    expect((await customerWalletRow(db, customer.id))!.balance).toBe('50.0000');
    // The same once the session cache is gone: the route's own rank gate answers the same words.
    await clearIdentityCaches(t);
    const again = await payFromBalance(client, token, 'after-move-2');
    expect(again.statusCode).toBe(403);
    expect(json(again).code).toBe('RANK_NOT_ALLOWED');
    expect(await db.select().from(s.orders)).toEqual([]);
  });

  it('refuses 403 FORBIDDEN for a checkout the account did not open itself: the guest row of its email is another buyer', async () => {
    const { customer, client } = await signedIn('50');
    const { token } = await openCheckout(t, world, { email: customer.email });
    const res = await payFromBalance(client, token, 'not-mine');
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('FORBIDDEN');
    expect(await db.select().from(s.payments)).toEqual([]);
  });

  it('still pays for the retail account that opened the checkout, as the account', async () => {
    const { customer, client } = await signedIn('50');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token, 'mine');
    expect(res.statusCode).toBe(201);
    const [order] = await db.select().from(s.orders);
    expect(order).toMatchObject({ accountId: customer.id, source: 'store' });
    const [payment] = await db.select().from(s.payments);
    expect(payment).toMatchObject({ accountId: customer.id, methodType: 'balance' });
  });
});

describe('the capture of a paid checkout never refuses for rank (decision 064)', () => {
  it('places a store order with VAT for an account that moved to a merchant rank after it paid the gateway', async () => {
    const { customer, client } = await signedIn();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const card = json(await pay(t, token, undefined, 'card-1')).payment;
    await moveToMerchantRank(customer.id);
    const event = storefrontEvent('evt_after_move', card.reference, { amount: card.amount, intent: 'pi_after_move' });
    expect((await hook(t, clock, 'payments', world.gateway.code, event)).statusCode).toBe(200);
    const [order] = await db.select().from(s.orders);
    // Paid first, so a shop order at the retail price with its VAT, whatever the rank is by now.
    expect(order).toMatchObject({ accountId: customer.id, source: 'store', taxAmount: '0.8000' });
    const [session] = await db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({ status: 'paid', orderId: order!.id, accountId: customer.id });
  });

  it('places the order of a signed-out checkout for its guest row, whose email is also a merchant login', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const { token } = await openCheckout(t, world, { email: merchant.email });
    const card = json(await pay(t, token, undefined, 'card-2')).payment;
    const event = storefrontEvent('evt_guest', card.reference, { amount: card.amount, intent: 'pi_guest' });
    expect((await hook(t, clock, 'payments', world.gateway.code, event)).statusCode).toBe(200);
    const [order] = await db.select().from(s.orders);
    expect(order?.accountId).not.toBe(merchant.id);
    expect(order).toMatchObject({ source: 'store' });
    expect(await db.select().from(s.orders).where(eq(s.orders.accountId, merchant.id))).toEqual([]);
  });
});

describe('the open_checkout blocker of the rank change (decision 064)', () => {
  const blockersOf = (accountId: number) =>
    db.transaction((tx) => t.app.get(RankChangeGuards).blockersOf(tx, accountId));

  it('is registered by the customers module', () => {
    expect(t.app.get(RankChangeGuards).names()).toContain('open_checkout');
  });

  it('blocks while the account has a checkout it opened signed in that is neither paid nor expired', async () => {
    const { customer, client } = await signedIn();
    expect(await blockersOf(customer.id)).toEqual([]);
    await openSignedInCheckout(client, world, customer.email);
    expect(await blockersOf(customer.id)).toEqual(['open_checkout']);
    // From the moment it runs out it no longer blocks (the end is exclusive).
    clock.advance(30 * MINUTE);
    expect(await blockersOf(customer.id)).toEqual([]);
  });

  it('does not block for a paid checkout, nor for a guest checkout typed with the account email (a merchant ignores that guest row)', async () => {
    const { customer, client } = await signedIn('50');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    expect((await payFromBalance(client, token, 'paid')).statusCode).toBe(201);
    // The paid checkout no longer blocks; the order it placed is still being worked on, which the orders module's own blocker names.
    expect(await blockersOf(customer.id)).toEqual(['live_order']);
    const merchant = await makeAccount(t, { rank: 'merchant' });
    await openCheckout(t, world, { email: merchant.email });
    expect(await blockersOf(merchant.id)).toEqual([]);
  });
});

describe('the customers participant of the guest claim', () => {
  const claim = (guestId: number, accountId: number) =>
    db.transaction((tx) => t.app.get(GuestClaimParticipants).moveAll(tx, { guestId, accountId }));

  /** A guest checkout with its consents, then run out (history), and the retail account that will claim it. */
  async function expiredGuestCheckout(email = 'visitor@mail.example') {
    const { token } = await openCheckout(t, world, { email });
    const [session] = await db.select().from(s.checkoutSessions);
    const guestId = session!.accountId!;
    clock.advance(31 * MINUTE);
    const account = await makeCustomer(t);
    return { token, sessionId: session!.id, guestId, account };
  }

  it('is registered under its own name', () => {
    expect(t.app.get(GuestClaimParticipants).names()).toContain('customers');
  });

  it('moves the sessions and the consents of the guest row, and only their pointers', async () => {
    const { sessionId, guestId, account } = await expiredGuestCheckout();
    const before = await db.select().from(s.consentRecords).orderBy(s.consentRecords.id);
    expect(before).toHaveLength(3);
    const moved = await claim(guestId, account.id);
    expect(moved.customers).toBe(4);
    const [session] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, sessionId));
    expect(session).toMatchObject({ accountId: account.id, email: 'visitor@mail.example' });
    const after = await db.select().from(s.consentRecords).orderBy(s.consentRecords.id);
    // Every proof column is byte for byte the same; only the subject's id changed.
    expect(after.map((row) => ({ ...row, subjectId: 0 }))).toEqual(before.map((row) => ({ ...row, subjectId: 0 })));
    expect(after.every((row) => row.subjectId === account.id)).toBe(true);
    // Nothing is left for the guest row, and a second claim moves nothing of this module.
    expect((await claim(guestId, account.id)).customers).toBe(0);
  });

  it('leaves the records of every other row alone', async () => {
    const { guestId, account } = await expiredGuestCheckout();
    const { token } = await openCheckout(t, world, { email: 'other@mail.example' });
    expect(token).toBeTruthy();
    await claim(guestId, account.id);
    const [other] = await db.select().from(s.clients).where(eq(s.clients.email, 'other@mail.example'));
    const rows = await db.select().from(s.checkoutSessions);
    expect(rows.filter((row) => row.accountId === other!.id)).toHaveLength(1);
    expect((await db.select().from(s.consentRecords)).filter((row) => row.subjectId === other!.id)).toHaveLength(3);
  });

  it('refuses while the guest row has a checkout that is still open (the guest may be paying), moving nothing', async () => {
    const { token } = await openCheckout(t, world, { email: 'visitor@mail.example' });
    expect(token).toBeTruthy();
    const [session] = await db.select().from(s.checkoutSessions);
    const account = await makeCustomer(t);
    const failure = await claim(session!.accountId!, account.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GuestClaimBusy);
    expect((await db.select().from(s.checkoutSessions))[0]?.accountId).toBe(session!.accountId);
    expect((await db.select().from(s.consentRecords)).every((row) => row.subjectId === session!.accountId)).toBe(true);
  });

  it('refuses at once with the lock error while another transaction holds a session of the guest row', async () => {
    const { sessionId, guestId, account } = await expiredGuestCheckout();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A card capture or a consent post that holds the session at the same moment.
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: s.checkoutSessions.id })
        .from(s.checkoutSessions)
        .where(eq(s.checkoutSessions.id, sessionId))
        .for('update');
      locked();
      await hold;
    });
    await holding;
    const started = performance.now();
    const failure = await claim(guestId, account.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(pgErrorInfo(failure)?.code).toBe('55P03');
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
    expect((await db.select().from(s.checkoutSessions))[0]?.accountId).toBe(guestId);
  });
});
