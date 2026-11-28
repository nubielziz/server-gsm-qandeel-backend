// Integration tests of the risk inputs (decision 050): the card's country and funding and the visitor's country reach the score, a declared tax
// country that the evidence contradicts is held for review, the blocks that follow a guest order attach to what it used and never to the
// account's standing (a guest checkout is the guest row of its email, never the login account that holds it: decision 064), and the API
// names at boot the rules that have no input.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { Blocklist } from '@src/modules/risk';
import { auditBlockLabel } from '@src/modules/risk/domain/blocklist-values';
import { RiskInputCheck } from '@src/modules/risk/application/risk-input-check';
import { accountRow, makeAccount } from '../../support/accounts';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  B2cGateway,
  type B2cWorld,
  DEFAULT_CARD,
  b2cWorld,
  hook,
  json,
  openCheckout,
  paidOrder,
  pay,
  storefrontEvent,
} from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { insertSupplierLink } from '../../support/catalog';
import { DAY, TestClock } from '../../support/clock';
import {
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';
import { seedDefaultTemplates } from '../../support/notifications';
import { eventsOf, orderRow, outboxOf } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { assessmentOf, auditRows, blocklistRows } from '../../support/risk';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, noAccountNotes } from '../../support/store';
import { APPLE_IMEI, TURNSTILE_HEADERS } from '../../support/storefront';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
const fake = new B2cGateway();
const ENV = { SHOP_ORIGINS: STORE_ORIGIN, GEOIP_COUNTRY_HEADER: 'CF-IPCountry' };
let t: TestApp;
let db: Database;
let world: B2cWorld;
let risk: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule], env: ENV });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
afterEach(() => {
  mock.restore();
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureAccountLinks(t);
  world = await b2cWorld(t, db, fake);
  await insertSupplierLink(db, world.icloud.serviceId);
  risk = await adminWith(t, ['risk:*', 'refunds:*', 'orders:*'], { name: 'Rami K.' });
});

type Rule = { id: string; on: boolean; value: number | null };

/** Saves the rules with the given numbers changed, as the console sends them (the whole set). */
async function setRules(values: Record<string, number>): Promise<void> {
  const current: Rule[] = (await risk.get('/admin/risk/rules')).body.rules;
  const rules = current.map(({ id, on, value }) => ({ id, on, value: id in values ? values[id]! : value }));
  expect((await risk.put('/admin/risk/rules', { rules })).status).toBe(200);
}

/** Rules that hold any first order above 1 USD (18 points, review from 10). */
const holdFirstOrders = () => setRules({ reviewFirstOrderAbove: 1, reviewThreshold: 10 });

const TAX_GB_CARD_US = 'Tax country GB differs from the card country US';

describe('what the score is fed from the payment', () => {
  it('feeds the card’s funding and country and the visitor’s country from the payment to the score', async () => {
    const paid = await paidOrder(t, clock, world, {
      country: 'GB',
      card: { ...DEFAULT_CARD, country: 'GB', funding: 'prepaid' },
      openHeaders: { 'cf-ipcountry': 'US' },
    });
    const assessment = await assessmentOf(db, paid.orderId);
    expect(assessment.signals).toEqual(['IP country differs from card country', 'Prepaid card BIN']);
    // 25 + 12: below the review threshold, and the card agrees with the declared country, so no tax signal.
    expect(assessment).toMatchObject({ decision: 'allow', score: 37 });
  });

  it('keeps the visitor’s country on the checkout from the configured header only', async () => {
    const countryOfLast = async () => {
      const [row] = await db.select().from(s.checkoutSessions).orderBy(desc(s.checkoutSessions.id)).limit(1);
      return row!.ipCountry;
    };
    await openCheckout(t, world, { headers: { 'cf-ipcountry': 'de' } });
    expect(await countryOfLast()).toBe('DE');
    for (const value of ['XX', 'T1', 'DEU', ' ']) {
      await openCheckout(t, world, { headers: { 'cf-ipcountry': value } });
      expect(await countryOfLast()).toBeNull();
    }
    await openCheckout(t, world);
    expect(await countryOfLast()).toBeNull();
    // Another header than the configured one says nothing.
    await openCheckout(t, world, { headers: { 'x-visitor-country': 'FR' } });
    expect(await countryOfLast()).toBeNull();
  });
});

describe('a declared tax country that the evidence contradicts', () => {
  it('holds for review a payment whose card was issued in another country than the declared one, and says so on the timeline', async () => {
    const paid = await paidOrder(t, clock, world, { country: 'GB', card: { ...DEFAULT_CARD, country: 'US' } });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'held' });
    expect(await outboxOf(db, 'order.dispatch_requested', paid.orderId)).toHaveLength(0);
    const assessment = await assessmentOf(db, paid.orderId);
    expect(assessment).toMatchObject({ decision: 'review', score: 0, signals: [TAX_GB_CARD_US] });
    const message = `Risk hold: score 0. ${TAX_GB_CARD_US}`;
    expect((await eventsOf(db, paid.orderId)).at(-1)!.data).toEqual({ message, reason: message });
    const queue = (await risk.get('/admin/risk/queue')).body;
    expect(queue.held.map((row: { orderId: number }) => row.orderId)).toEqual([paid.orderId]);
    // The declared country stands when staff approve.
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/approve`)).status).toBe(204);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ dispatchState: 'pending' });
  });

  it('uses the visitor’s country when the card does not say its country', async () => {
    const paid = await paidOrder(t, clock, world, { country: 'GB', openHeaders: { 'cf-ipcountry': 'US' } });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ dispatchState: 'held' });
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({
      decision: 'review',
      signals: ['Tax country GB differs from the IP country US'],
    });
  });

  it('does not hold a payment whose card country agrees, or one with no evidence', async () => {
    const agrees = await paidOrder(t, clock, world, { country: 'GB', card: { ...DEFAULT_CARD, country: 'GB' } });
    expect(await orderRow(db, agrees.orderId)).toMatchObject({ dispatchState: 'pending' });
    const unknown = await paidOrder(t, clock, world, { email: 'other@mail.example', country: 'GB' });
    expect(await orderRow(db, unknown.orderId)).toMatchObject({ dispatchState: 'pending' });
  });

  it('holds only while the shop has a tax window in force', async () => {
    await db.delete(s.taxRates);
    const paid = await paidOrder(t, clock, world, { country: 'GB', card: { ...DEFAULT_CARD, country: 'US' } });
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending', dispatchState: 'pending' });
    expect(await assessmentOf(db, paid.orderId)).toMatchObject({ decision: 'allow', signals: [] });
  });
});

/** The checkout of a guest, opened over HTTP, answered as it is (not only on success). */
function openAsGuest(email: string) {
  return t.app.inject({
    method: 'POST',
    url: '/store/v1/checkout-sessions',
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: {
      serviceId: world.icloud.serviceId,
      email,
      country: 'GB',
      currency: 'GBP',
      imei: APPLE_IMEI,
    },
  });
}

/** A signed-in account pays a checkout by card: sign in, open, pay and the gateway's signed confirmation; returns the order id. */
async function signedInPaidOrder(accountId: number, email: string): Promise<number> {
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(email)).statusCode).toBe(200);
  const { token } = await openSignedInCheckout(client, world, email);
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  const { payment } = json(started);
  const suffix = crypto.randomUUID().slice(0, 8);
  const body = storefrontEvent(`evt_signed_${suffix}`, payment.reference, {
    amount: payment.amount,
    currency: payment.currency,
    intent: `pi_signed_${suffix}`,
    card: { ...DEFAULT_CARD, fingerprint: 'fp_signed' },
  });
  expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
  const [order] = await db.select().from(s.orders).where(eq(s.orders.accountId, accountId)).orderBy(desc(s.orders.id));
  return order!.id;
}

describe('the blocks that follow a guest order', () => {
  it('a refund of a guest order that blocks its email stops guest checkouts with that email, never its account', async () => {
    const account = await makeAccount(t, {
      rank: 'retail',
      email: 'owner@mail.example',
      emailVerifiedAt: new Date(clock.nowMs() - DAY),
    });
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world, {
      email: 'owner@mail.example',
      card: { ...DEFAULT_CARD, fingerprint: 'fp_guest' },
    });
    const guestOrder = await orderRow(db, paid.orderId);
    expect(guestOrder).toMatchObject({ dispatchState: 'held' });
    // The guest checkout is the guest row of the email, never the login account that holds the same email (decision 064).
    expect(guestOrder.accountId).not.toBe(account.id);
    expect((await accountRow(guestOrder.accountId)).hasAccount).toBe(false);
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/refund`, { blockEmail: true })).status).toBe(204);
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => [entry.kind, entry.guestOnly])).toEqual([
      ['email', true],
      ['card', false],
    ]);
    expect(entries[0]!.reason).toEndWith(' (guest checkouts only)');
    const audit = (await auditRows(db, 'order', paid.orderId)).find(
      (row) => row.action === 'refunded after risk review',
    );
    expect(audit!.after).toMatchObject({ emailScope: 'guest checkouts' });
    // A guest with that email is refused like any blocked email; the account signs in and checks out signed in.
    const refused = await openAsGuest('owner@mail.example');
    expect(refused.statusCode).toBe(403);
    expect(json(refused).code).toBe('ACCOUNT_SUSPENDED');
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login('owner@mail.example')).statusCode).toBe(200);
    const signedIn = await client.call(
      'POST',
      '/store/v1/checkout-sessions',
      {
        serviceId: world.icloud.serviceId,
        email: 'owner@mail.example',
        country: 'GB',
        currency: 'GBP',
        imei: APPLE_IMEI,
      },
      { headers: { 'user-agent': 'Mozilla/5.0 (test)' } },
    );
    expect(signedIn.statusCode).toBe(201);
    expect(await accountRow(account.id)).toMatchObject({ status: 'active' });
    expect(await t.app.get(Blocklist).isEmailBlocked(db, 'owner@mail.example')).toBe(false);
  });

  it('a refund of a guest order whose email had no account blocks it everywhere, with the card', async () => {
    await holdFirstOrders();
    const paid = await paidOrder(t, clock, world, {
      email: 'newbuyer@mail.example',
      card: { ...DEFAULT_CARD, fingerprint: 'fp_new' },
    });
    // Before the block the address is mailed (the note with the sign-up page: no account uses it, decision 079).
    const before = new StoreClient(t, freshClientIp());
    const asked = await before.magicLink('newbuyer@mail.example');
    expect([asked.statusCode, asked.body]).toEqual([204, '']);
    expect(accountLinks()).toHaveLength(0);
    expect(await noAccountNotes()).toHaveLength(1);
    expect((await risk.post(`/admin/risk/orders/${paid.orderId}/refund`, { blockEmail: true })).status).toBe(204);
    expect((await blocklistRows(db)).map((entry) => [entry.kind, entry.guestOnly])).toEqual([
      ['email', false],
      ['card', false],
    ]);
    const audit = (await auditRows(db, 'order', paid.orderId)).find(
      (row) => row.action === 'refunded after risk review',
    );
    expect((audit!.after as Record<string, unknown>)['emailScope']).toBeUndefined();
    expect(await t.app.get(Blocklist).isEmailBlocked(db, 'newbuyer@mail.example')).toBe(true);
    // After it, nothing is mailed to it.
    const after = new StoreClient(t, freshClientIp());
    expect((await after.magicLink('newbuyer@mail.example')).statusCode).toBe(204);
    expect(accountLinks()).toHaveLength(0);
    expect(await noAccountNotes()).toHaveLength(1);
  });

  it('a refund of a signed-in order that blocks its email blocks it everywhere, as before', async () => {
    const account = await makeAccount(t, {
      rank: 'retail',
      email: 'member@mail.example',
      emailVerifiedAt: new Date(clock.nowMs() - DAY),
    });
    await holdFirstOrders();
    const orderId = await signedInPaidOrder(account.id, 'member@mail.example');
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'held' });
    expect((await risk.post(`/admin/risk/orders/${orderId}/refund`, { blockEmail: true })).status).toBe(204);
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => [entry.kind, entry.guestOnly])).toEqual([['email', false]]);
    expect(await t.app.get(Blocklist).isEmailBlocked(db, 'member@mail.example')).toBe(true);
    const audit = (await auditRows(db, 'order', orderId)).find((row) => row.action === 'refunded after risk review');
    expect((audit!.after as Record<string, unknown>)['emailScope']).toBeUndefined();
  });
});

describe('a full block over an entry limited to guest checkouts', () => {
  it('a refund of a signed-in order that blocks its email widens the limited entry and says so in the audit row', async () => {
    const account = await makeAccount(t, {
      rank: 'retail',
      email: 'owner@mail.example',
      emailVerifiedAt: new Date(clock.nowMs() - DAY),
    });
    await holdFirstOrders();
    // A guest order of the account's email, refunded with the email block: a limited entry plus the card.
    const guest = await paidOrder(t, clock, world, {
      email: 'owner@mail.example',
      card: { ...DEFAULT_CARD, fingerprint: 'fp_guest' },
    });
    expect((await risk.post(`/admin/risk/orders/${guest.orderId}/refund`, { blockEmail: true })).status).toBe(204);
    const limited = await blocklistRows(db);
    expect(limited.map((entry) => [entry.kind, entry.guestOnly])).toEqual([
      ['email', true],
      ['card', false],
    ]);
    expect(await t.app.get(Blocklist).isEmailBlocked(db, 'owner@mail.example')).toBe(false);
    // The account then pays signed in with another card and is held; staff refund it and block the email for the whole shop.
    const orderId = await signedInPaidOrder(account.id, 'owner@mail.example');
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'held' });
    expect((await risk.post(`/admin/risk/orders/${orderId}/refund`, { blockEmail: true })).status).toBe(204);
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => [entry.kind, entry.guestOnly])).toEqual([
      ['email', false],
      ['card', false],
    ]);
    // The same row, widened: it keeps its id, and the reason is the staff member's, without the scope words.
    expect(entries[0]!.id).toBe(limited[0]!.id);
    expect(entries[0]!.reason).not.toContain('guest checkouts only');
    expect(entries[0]!.createdBy).toBe(limited[0]!.createdBy);
    expect(await t.app.get(Blocklist).isEmailBlocked(db, 'owner@mail.example')).toBe(true);
    const audit = (await auditRows(db, 'order', orderId)).find((row) => row.action === 'refunded after risk review');
    const after = audit!.after as Record<string, unknown>;
    expect(after['blocked']).toEqual([auditBlockLabel(entries[0]!)]);
    expect(after['emailScopeBefore']).toBe('guest checkouts');
    expect(after['emailScope']).toBeUndefined();
    // The account can no longer sign in by link: no link is made.
    const links = accountLinks().length;
    const asked = await new StoreClient(t, freshClientIp()).magicLink('owner@mail.example');
    expect(asked.statusCode).toBe(204);
    expect(accountLinks()).toHaveLength(links);
  });
});

describe('a payment from the store balance', () => {
  it('is screened with the visitor’s country kept on its checkout, and as the account’s own signed-in payment', async () => {
    await walletSettings(t, db);
    await seedDefaultTemplates(db);
    await insertWalletTemplates(db);
    const account = await makeAccount(t, { rank: 'retail', email: 'wallet@mail.example' });
    await fundCustomer(db, account.id, '50');
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login('wallet@mail.example')).statusCode).toBe(200);
    const { token } = await openSignedInCheckout(client, world, 'wallet@mail.example', {
      headers: { 'cf-ipcountry': 'US' },
    });
    const [session] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.accountId, account.id));
    expect(session).toMatchObject({ ipCountry: 'US', openedSignedIn: true });
    const paid = await payFromBalance(client, token, 'balance-1');
    expect(paid.statusCode).toBe(201);
    const orderId = json(paid).order.id as number;
    expect(await orderRow(db, orderId)).toMatchObject({ dispatchState: 'held' });
    expect(await assessmentOf(db, orderId)).toMatchObject({
      decision: 'review',
      signals: ['Tax country GB differs from the IP country US'],
    });
  });
});

describe('the boot warning of the rules without an input', () => {
  const NAMED = 'Risk rule without an input source: ';
  const warnings = () =>
    logSink.lines.filter((line) => line.level === 40 && typeof line.msg === 'string' && line.msg.startsWith(NAMED));

  it('names the IP-country rule, and only it, when the visitor country has no header', async () => {
    logSink.clear();
    const bare = await createTestApp({ clock });
    try {
      const texts = warnings().map((line) => line.msg as string);
      expect(texts).toEqual([
        `${NAMED}Hold when the IP country differs from the card country. No visitor country: GEOIP_COUNTRY_HEADER is not set.`,
      ]);
      expect((await bare.app.get(RiskInputCheck).gaps()).map((gap) => gap.name)).toEqual(['reviewIpCountryMismatch']);
    } finally {
      await bare.close();
    }
  });

  it('does not name the IP-country rule when the header is configured', async () => {
    logSink.clear();
    const withHeader = await createTestApp({ clock, env: ENV });
    try {
      const texts = warnings().map((line) => line.msg as string);
      expect(texts).toEqual([]);
      expect(await withHeader.app.get(RiskInputCheck).gaps()).toEqual([]);
    } finally {
      await withHeader.close();
    }
  });
});
