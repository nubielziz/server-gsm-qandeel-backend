// Integration tests of the guest-order claim that rides on the sign-in link exchange (decision 064; POST /store/v1/auth/verify with
// `claimGuestOrders`): the records of the guest row of an email move to the retail account that proved the mailbox, only when asked, only at the
// retail rank, never while the guest row is mid-flight, and never by making the sign-in wait. The participants are registered by the
// modules that own the records, so these cases pass once every one of them is merged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureMerchantGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import {
  insertAnyService,
  insertCustomerHistory,
  insertCustomerOrder,
  insertStoreCurrencies,
  insertTaxRates,
} from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertInvoiceRow } from '../../support/billing';
import { insertCheckout } from '../../support/growth';
import { clearAccountMailLimits, seedIdentityTemplates } from '../../support/identity-mail';
import { freshClientIp } from '../../support/pipeline-routes';
import { auditRows } from '../../support/risk';
import { insertFileRow } from '../../support/support-accounts';
import { insertSupportMessage } from '../../support/support';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-24T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: STORE_ORIGIN } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-24T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  captureAccountLinks(t);
});
afterEach(() => mock.restore());

const store = () => new StoreClient(t, freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string };

/** What the sign-in answers about the claim. */
interface ClaimAnswer {
  readonly id: number;
  readonly next: string;
  readonly claimedOrders: number;
  readonly claimSkipped?: string;
}

/** Asks for a link as the account's holder and exchanges it, ticking (or not) the box that claims the guest orders. */
async function signIn(email: string, accountId: number, claimGuestOrders: boolean) {
  const browser = store();
  expect((await browser.magicLink(email)).statusCode).toBe(204);
  // The newest link: an earlier sign-in of the same test used its own.
  const link = accountLinks()
    .filter((candidate) => candidate.kind === 'magic_link' && candidate.accountId === accountId)
    .at(-1)!;
  const res = await browser.call('POST', '/store/v1/auth/verify', { token: link.token, claimGuestOrders });
  return { browser, res, answer: res.json<ClaimAnswer>() };
}

/** A retail account with a login, and the guest row of the same email with one of every kind of record that hangs on a guest. */
async function worldOf(guestOverrides: Partial<typeof s.clients.$inferInsert> = {}) {
  const { db } = await testDb();
  await insertStoreCurrencies(db);
  const buyer = await makeCustomer(t, { name: 'Dana Buyer' });
  const guest = await makeCustomer(t, { guest: true, email: buyer.email, name: 'Dana', ...guestOverrides });
  const serviceId = await insertAnyService(db);
  const orderId = await insertCustomerOrder(db, serviceId, guest.id);
  const checkout = await insertCheckout(t, db, {
    serviceId,
    createdAt: new Date(clock.nowMs()),
    email: buyer.email,
    noCustomer: true,
    status: 'paid',
    orderId,
  });
  await db.update(s.checkoutSessions).set({ accountId: guest.id }).where(eq(s.checkoutSessions.id, checkout.sessionId));
  await db.insert(s.consentRecords).values({
    subjectType: 'account',
    subjectId: guest.id,
    purpose: 'terms',
    granted: true,
    checkoutSessionId: checkout.sessionId,
    orderId,
    ip: '203.0.113.5',
  });
  // a captured payment, a refund, a dispute and a ticket of the guest row
  await insertCustomerHistory(db, guest.id, orderId);
  // a receipt names its buyer by account_id only, as the receipt writer makes it (the old client_id column is for merchant invoices)
  await insertInvoiceRow(db, guest.id, { kind: 'receipt', orderId, legacyClientId: null });
  await db.insert(s.riskAssessments).values({
    accountId: guest.id,
    orderId,
    checkoutSessionId: checkout.sessionId,
    score: 12,
    decision: 'allow',
    signals: [],
  });
  // the message goes on the ticket the history made, so the guest row holds one ticket
  const [ticket] = await db
    .select({ id: s.supportTickets.id })
    .from(s.supportTickets)
    .where(eq(s.supportTickets.requesterId, guest.id));
  await insertSupportMessage(db, ticket!.id, { authorType: 'account', authorId: guest.id });
  await insertFileRow(db, 'account', guest.id);
  return { buyer, guest, orderId, checkoutId: checkout.sessionId };
}

/** How many records of every kind an account holds. */
async function recordsOf(accountId: number) {
  const { db } = await testDb();
  const count = async (query: Promise<Array<{ n: number }>>) => (await query)[0]!.n;
  return {
    orders: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.orders)
        .where(eq(s.orders.accountId, accountId)),
    ),
    checkouts: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.checkoutSessions)
        .where(eq(s.checkoutSessions.accountId, accountId)),
    ),
    consents: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.consentRecords)
        .where(eq(s.consentRecords.subjectId, accountId)),
    ),
    payments: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.payments)
        .where(eq(s.payments.accountId, accountId)),
    ),
    invoices: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.invoices)
        .where(eq(s.invoices.accountId, accountId)),
    ),
    refunds: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.refunds)
        .where(eq(s.refunds.accountId, accountId)),
    ),
    disputes: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.disputes)
        .where(eq(s.disputes.accountId, accountId)),
    ),
    risk: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.riskAssessments)
        .where(eq(s.riskAssessments.accountId, accountId)),
    ),
    tickets: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.supportTickets)
        .where(eq(s.supportTickets.requesterId, accountId)),
    ),
    files: await count(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.files)
        .where(eq(s.files.ownerId, accountId)),
    ),
  };
}

const ONE_OF_EACH = {
  orders: 1,
  checkouts: 1,
  consents: 1,
  payments: 1,
  invoices: 1,
  refunds: 1,
  disputes: 1,
  risk: 1,
  tickets: 1,
  files: 1,
};
const NONE: typeof ONE_OF_EACH = {
  orders: 0,
  checkouts: 0,
  consents: 0,
  payments: 0,
  invoices: 0,
  refunds: 0,
  disputes: 0,
  risk: 0,
  tickets: 0,
  files: 0,
};

describe('the claim of the guest orders in POST /store/v1/auth/verify', () => {
  it('moves orders, checkout sessions, consents, payments, invoices, refunds, disputes, risk assessments, tickets and their files from the guest row to the account', async () => {
    const { buyer, guest } = await worldOf();
    expect(await recordsOf(guest.id)).toEqual(ONE_OF_EACH);
    expect(await recordsOf(buyer.id)).toEqual(NONE);

    const { res, answer, browser } = await signIn(buyer.email, buyer.id, true);
    expect(res.statusCode).toBe(200);
    expect(answer).toMatchObject({ id: buyer.id, next: 'done', claimedOrders: 1 });
    expect(answer.claimSkipped).toBeUndefined();
    expect((await browser.me()).statusCode).toBe(200);

    expect(await recordsOf(guest.id)).toEqual(NONE);
    expect(await recordsOf(buyer.id)).toEqual(ONE_OF_EACH);
    // The guest row stays, empty and without a login; the orders of the account list now shows the claimed order.
    expect(await accountRow(guest.id)).toMatchObject({ hasAccount: false, email: buyer.email });
    const orders = await browser.orders();
    expect(orders.headers['x-total-count']).toBe('1');
    expect(orders.json<Array<{ id: number }>>()).toHaveLength(1);
  });

  it('writes one audit row naming the account and the counts, and no email', async () => {
    const { buyer, guest } = await worldOf();
    await signIn(buyer.email, buyer.id, true);
    const { db } = await testDb();
    const rows = await auditRows(db, 'account', buyer.id);
    const claim = rows.filter((row) => row.action === 'claimed guest orders');
    expect(claim).toHaveLength(1);
    expect(claim[0]).toMatchObject({
      entityType: 'account',
      entityId: buyer.id,
      actorType: 'account',
      actorId: buyer.id,
    });
    expect(claim[0]!.after).toMatchObject({ guestId: guest.id, orders: 1 });
    expect(JSON.stringify(claim[0])).not.toContain(buyer.email);
  });

  it('moves nothing without the box, and the sign-in still works', async () => {
    const { buyer, guest } = await worldOf();
    const { res, answer } = await signIn(buyer.email, buyer.id, false);
    expect(res.statusCode).toBe(200);
    expect(answer).toMatchObject({ claimedOrders: 0 });
    expect(await recordsOf(guest.id)).toEqual(ONE_OF_EACH);
    expect(await recordsOf(buyer.id)).toEqual(NONE);
    const { db } = await testDb();
    expect((await auditRows(db, 'account', buyer.id)).filter((row) => row.action === 'claimed guest orders')).toEqual(
      [],
    );
  });

  it('moves nothing for a blocked guest row, and the sign-in still works', async () => {
    const { buyer, guest } = await worldOf({ status: 'blocked' });
    const { res, answer } = await signIn(buyer.email, buyer.id, true);
    expect(res.statusCode).toBe(200);
    expect(answer).toMatchObject({ claimedOrders: 0 });
    expect(answer.claimSkipped).toBeUndefined();
    expect(await recordsOf(guest.id)).toEqual(ONE_OF_EACH);
  });

  it('moves nothing for a merchant rank: a link of an account raised to a merchant rank is dead (410) and the guest row is untouched', async () => {
    const { buyer, guest } = await worldOf();
    const browser = store();
    await browser.magicLink(buyer.email);
    const link = accountLinks().find((candidate) => candidate.accountId === buyer.id)!;
    const { db } = await testDb();
    await db
      .update(s.clients)
      .set({ groupId: await ensureMerchantGroup(db) })
      .where(eq(s.clients.id, buyer.id));

    const res = await browser.call('POST', '/store/v1/auth/verify', { token: link.token, claimGuestOrders: true });
    expect(res.statusCode).toBe(410);
    expect(problem(res).code).toBe('TOKEN_INVALID');
    expect(await recordsOf(guest.id)).toEqual(ONE_OF_EACH);
    expect(await recordsOf(buyer.id)).toEqual(NONE);
  });

  it('offers no claim to a guest row that becomes an account: it holds its own records already', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    await insertTaxRates(db, ['GB']);
    const guest = await makeCustomer(t, { guest: true, name: 'Dana' });
    const serviceId = await insertAnyService(db);
    await insertCustomerOrder(db, serviceId, guest.id);

    // Since decision 079 a guest row becomes an account through the sign-up, whose link the same browser opens.
    const browser = store();
    expect((await browser.signUp({ email: guest.email })).statusCode).toBe(204);
    const link = accountLinks().find((candidate) => candidate.accountId === guest.id)!;
    const res = await browser.call('POST', '/store/v1/auth/verify', { token: link.token, claimGuestOrders: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<ClaimAnswer>()).toMatchObject({ id: guest.id, claimedOrders: 0 });
    expect(await accountRow(guest.id)).toMatchObject({ hasAccount: true });
    expect((await recordsOf(guest.id)).orders).toBe(1);
  });

  it('leaves the guest rows of other emails alone', async () => {
    const { buyer } = await worldOf();
    const other = await makeCustomer(t, { guest: true, email: 'someone.else@example.com' });
    const { db } = await testDb();
    const serviceId = await insertAnyService(db);
    await insertCustomerOrder(db, serviceId, other.id);

    await signIn(buyer.email, buyer.id, true);
    expect((await recordsOf(other.id)).orders).toBe(1);
    expect((await recordsOf(buyer.id)).orders).toBe(1);
  });
});

describe('the claim gives up with busy instead of waiting', () => {
  it('answers busy at once, and signs in, while another connection holds a row a participant needs (a dispute webhook, a refund approval)', async () => {
    const { buyer, guest } = await worldOf();
    const { db } = await testDb();
    let release!: () => void;
    let held!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const taken = new Promise<void>((resolve) => (held = resolve));
    // A second connection locks the dispute row of the guest, as a dispute webhook does while it posts.
    const holder = db.transaction(async (tx) => {
      await tx.select().from(s.disputes).where(eq(s.disputes.accountId, guest.id)).for('update');
      held();
      await open;
    });
    await taken;

    // The lock is let go even when an assertion fails, so a failure here cannot hold the rows the next tests reset.
    try {
      const started = Date.now();
      const { res, answer, browser } = await signIn(buyer.email, buyer.id, true);
      const waited = Date.now() - started;
      expect(res.statusCode).toBe(200);
      expect(answer).toMatchObject({ id: buyer.id, next: 'done', claimedOrders: 0, claimSkipped: 'busy' });
      // The claim never waited for the lock: it answered while the other connection still held the row.
      expect(waited).toBeLessThan(5_000);
      expect((await browser.me()).statusCode).toBe(200);
      // Nothing moved, not even the records of the participants that ran before the one that met the lock.
      expect(await recordsOf(guest.id)).toEqual(ONE_OF_EACH);
      expect(await recordsOf(buyer.id)).toEqual(NONE);
    } finally {
      release();
      await holder;
    }

    // Once the row is free, the next link and claim move everything.
    clock.advance(60_000);
    const again = await signIn(buyer.email, buyer.id, true);
    expect(again.answer).toMatchObject({ claimedOrders: 1 });
    expect(await recordsOf(buyer.id)).toEqual(ONE_OF_EACH);
  });

  it('answers busy while the guest row has a pending payment, an open checkout session or a ledger account, and moves nothing', async () => {
    const cases: Array<[string, (guestId: number, checkoutId: number) => Promise<void>]> = [
      [
        'a pending payment',
        async (guestId) => {
          const { db } = await testDb();
          await db.update(s.payments).set({ status: 'pending' }).where(eq(s.payments.accountId, guestId));
        },
      ],
      [
        'an open checkout session',
        async (_guestId, checkoutId) => {
          const { db } = await testDb();
          await db
            .update(s.checkoutSessions)
            .set({ status: 'open', orderId: null })
            .where(eq(s.checkoutSessions.id, checkoutId));
        },
      ],
      [
        'a ledger account',
        async (guestId) => {
          const { db } = await testDb();
          await db
            .insert(s.ledgerAccounts)
            .values({ kind: 'customer_wallet', ownerType: 'account', ownerId: guestId, currency: 'USD' });
        },
      ],
    ];
    for (const [, prepare] of cases) {
      await resetDb();
      await clearIdentityCaches(t);
      await clearStoreRateLimits(t);
      await clearAccountMailLimits(t);
      await seedIdentityTemplates((await testDb()).db);
      captureAccountLinks(t);
      const { buyer, guest, checkoutId } = await worldOf();
      await prepare(guest.id, checkoutId);
      const before = await recordsOf(guest.id);

      const { res, answer } = await signIn(buyer.email, buyer.id, true);
      expect(res.statusCode).toBe(200);
      expect(answer).toMatchObject({ claimedOrders: 0, claimSkipped: 'busy' });
      expect(await recordsOf(guest.id)).toEqual(before);
      expect(await recordsOf(buyer.id)).toEqual(NONE);
      const { db } = await testDb();
      expect(
        await db
          .select()
          .from(s.sessions)
          .where(and(eq(s.sessions.subjectId, buyer.id), isNull(s.sessions.revokedAt))),
      ).toHaveLength(1);
    }
  });
});
