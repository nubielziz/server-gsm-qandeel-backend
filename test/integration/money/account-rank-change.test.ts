// Integration tests of the rank change (decision 064): `POST /admin/clients/:id/rank`. The Owner's check and the required key, every blocker
// alone and together with nothing written, the replay of a key, the balance move of both directions under `rank:<id>:<key>`, the credit limit,
// the sessions and keys that end, the invitation of an account without a password, the change inside one kind, a chain of changes, and the
// history that outlives a deleted rank. The checks of other modules (live orders, open checkouts) are registered here as stand-ins; the
// modules' own checks are tested with their modules.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { MerchantAccounts, RankChangeGuards, type RankBlockerCode } from '@src/modules/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { makeAccount, accountRow, ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { openAccountSession } from '../../support/account-sessions';
import { insertGateway, insertInvoiceRow } from '../../support/billing';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { fundCustomer } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd, insertOrderParents } from '../../support/fixtures';
import { insertApiKey } from '../../support/machine-auth';
import { fundWallet, ledgerTotals, placeOrderHold } from '../../support/money';
import { insertOrderRow } from '../../support/orders';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;
/** What the stand-in checks of the orders and customers modules report, by account. */
const reported = new Map<number, RankBlockerCode[]>();

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
  t.app
    .get(RankChangeGuards)
    .register('test:other-modules', (_tx, accountId) => Promise.resolve(reported.get(accountId) ?? []));
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  reported.clear();
  await insertUsd(db);
  owner = await adminWith(t, ['*'], { name: 'Owner One' });
});

/** The ranks of a test: the retail one, a merchant rank with credit and a merchant rank without. */
async function ranks() {
  const retailId = await ensureRetailGroup(db);
  const [gold] = await db
    .insert(s.clientGroups)
    .values({ name: 'Gold', kind: 'b2b', overdraftAllowed: true })
    .returning({ id: s.clientGroups.id });
  const [basic] = await db
    .insert(s.clientGroups)
    .values({ name: 'Basic', kind: 'b2b', overdraftAllowed: false })
    .returning({ id: s.clientGroups.id });
  return { retailId, goldId: gold!.id, basicId: basic!.id };
}

/** A merchant of a rank with its wallet and hold opened, a credit limit and a balance. */
async function merchantOf(groupId: number, options: { balance?: string; creditLimit?: string } = {}) {
  const account = await makeAccount({ rank: 'merchant', groupId });
  await new MerchantAccounts().open(db, {
    clientId: account.id,
    currency: 'USD',
    // The opener takes the wire form of an amount (four decimals); the cases give short ones.
    creditLimit: Money.of(options.creditLimit ?? '0').toWire(),
    overdraftAllowed: true,
  });
  if (options.balance) await fundWallet(db, account.id, options.balance);
  return account;
}

/** A retail account with a store balance. */
async function retailWith(balance: string, options: { password?: string | null } = {}) {
  const account = await makeAccount({
    rank: 'retail',
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  if (balance !== '0') await fundCustomer(db, account.id, balance);
  return account;
}

/** Asks for the rank change with a key of its own unless one is given. */
function change(api: AdminApi, accountId: number, groupId: number, key = `k-${crypto.randomUUID()}`) {
  return api.post(`/admin/clients/${accountId}/rank`, { groupId }, { 'idempotency-key': key });
}

/** The ledger accounts of an account, by kind. */
async function walletsOf(accountId: number) {
  const rows = await db
    .select()
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'account'), eq(s.ledgerAccounts.ownerId, accountId)));
  return new Map(rows.map((row) => [row.kind, row]));
}

/** The rank changes of an account, oldest first. */
function historyOf(accountId: number) {
  return db
    .select()
    .from(s.accountRankChanges)
    .where(eq(s.accountRankChanges.accountId, accountId))
    .orderBy(asc(s.accountRankChanges.id));
}

/** The balance moves the rank change posted for an account, oldest first. */
function transfersOf(accountId: number) {
  return db
    .select()
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.kind, 'wallet_transfer'), eq(s.ledgerTransactions.refId, accountId)))
    .orderBy(asc(s.ledgerTransactions.id));
}

/** The sessions of an account that are still live. */
async function liveSessionsOf(accountId: number): Promise<number> {
  const rows = await db
    .select({ id: s.sessions.id })
    .from(s.sessions)
    .where(
      and(eq(s.sessions.subjectType, 'account'), eq(s.sessions.subjectId, accountId), isNull(s.sessions.revokedAt)),
    );
  return rows.length;
}

/** The API keys of an account that are still live. */
async function liveKeysOf(accountId: number): Promise<number> {
  const rows = await db
    .select({ id: s.apiKeys.id })
    .from(s.apiKeys)
    .where(and(eq(s.apiKeys.clientId, accountId), isNull(s.apiKeys.revokedAt)));
  return rows.length;
}

/** Proves that a refused change left everything as it was. */
async function expectUntouched(accountId: number, groupId: number, sessions: number) {
  expect((await accountRow(accountId)).groupId).toBe(groupId);
  expect(await historyOf(accountId)).toHaveLength(0);
  expect(await transfersOf(accountId)).toHaveLength(0);
  expect(await liveSessionsOf(accountId)).toBe(sessions);
}

describe('who may change a rank, and what a request needs', () => {
  it('refuses a staff member who is not an Owner, whatever permissions the role holds, and writes nothing', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '40' });
    await openAccountSession(t, account.id);
    const clerk = await adminWith(t, ['clients:*', 'groups:*', 'wallet:*']);
    const res = await change(clerk, account.id, retailId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await expectUntouched(account.id, goldId, 1);
    expect((await walletsOf(account.id)).get('client_wallet')!.balance).toBe('40.0000');
  });

  it('answers 422 without an Idempotency-Key and changes nothing', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId);
    const res = await owner.post(`/admin/clients/${account.id}/rank`, { groupId: retailId });
    expect(res.status).toBe(422);
    await expectUntouched(account.id, goldId, 0);
  });

  it('answers 422 on groupId for a rank that does not exist, for the rank the account already has and for a body with more keys', async () => {
    const { goldId, basicId } = await ranks();
    const account = await merchantOf(goldId);
    const missing = await change(owner, account.id, 987654);
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0]).toMatchObject({ field: 'groupId', code: 'unknown_rank' });
    const same = await change(owner, account.id, goldId);
    expect(same.status).toBe(422);
    expect(same.body.errors[0]).toMatchObject({ field: 'groupId', code: 'same_rank' });
    const extra = await owner.post(
      `/admin/clients/${account.id}/rank`,
      { groupId: basicId, creditLimit: '100.0000' },
      { 'idempotency-key': 'k-extra' },
    );
    expect(extra.status).toBe(422);
    await expectUntouched(account.id, goldId, 0);
  });

  it('answers 404 for an account that does not exist and 409 ANONYMIZED for an anonymized one', async () => {
    const { retailId, goldId } = await ranks();
    expect((await change(owner, 987654, retailId)).status).toBe(404);
    const gone = await makeAccount({
      rank: 'merchant',
      groupId: goldId,
      status: 'anonymized',
      anonymizedAt: clock.now(),
    });
    const res = await change(owner, gone.id, retailId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ANONYMIZED');
    expect(await historyOf(gone.id)).toHaveLength(0);
  });
});

describe('the blockers of a change across kinds, each alone', () => {
  /** What the response must say, the account's rank and what to keep an eye on afterwards. */
  async function expectBlocked(accountId: number, groupId: number, target: number, codes: string[]) {
    const res = await change(owner, accountId, target);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RANK_CHANGE_BLOCKED');
    expect(res.body.errors.map((entry: { field: string; code: string }) => [entry.field, entry.code])).toEqual(
      codes.map((code) => ['groupId', code]),
    );
    for (const entry of res.body.errors as Array<{ message: string }>) expect(entry.message.length).toBeGreaterThan(5);
    expect(await historyOf(accountId)).toHaveLength(0);
    expect(await transfersOf(accountId)).toHaveLength(0);
    expect((await accountRow(accountId)).groupId).toBe(groupId);
  }

  it('guest: a guest keeps the retail rank', async () => {
    const { goldId } = await ranks();
    const guest = await makeAccount({ rank: 'retail', guest: true });
    await expectBlocked(guest.id, guest.groupId, goldId, ['guest']);
  });

  it('open_hold: orders still hold part of the merchant wallet', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '50' });
    await placeOrderHold(db, account.id, '10');
    await expectBlocked(account.id, goldId, retailId, ['open_hold']);
  });

  it('live_order and open_checkout: the checks other modules register are merged into the answer', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '5' });
    reported.set(account.id, ['open_checkout', 'live_order']);
    await expectBlocked(account.id, goldId, retailId, ['live_order', 'open_checkout']);
  });

  it('open_topup: a top-up invoice that is still live', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '5' });
    await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'open', createdAt: clock.now() });
    await expectBlocked(account.id, goldId, retailId, ['open_topup']);
  });

  it('open_topup: a manual invoice of staff blocks, a manual gateway never expires, a pending top-up payment blocks', async () => {
    const { retailId, goldId } = await ranks();
    const old = new Date('2026-10-01T00:00:00.000Z');
    const manualKind = await merchantOf(goldId);
    await insertInvoiceRow(db, manualKind.id, { kind: 'manual', status: 'open', createdAt: old });
    await expectBlocked(manualKind.id, goldId, retailId, ['open_topup']);

    const gatewayId = await insertGateway(t, db, { isManual: true });
    const manualGateway = await merchantOf(goldId);
    await insertInvoiceRow(db, manualGateway.id, { kind: 'topup', status: 'open', gatewayId, createdAt: old });
    await expectBlocked(manualGateway.id, goldId, retailId, ['open_topup']);

    const waiting = await merchantOf(goldId);
    const paid = await insertInvoiceRow(db, waiting.id, { kind: 'topup', status: 'paid', createdAt: old });
    await db.insert(s.payments).values({
      accountId: waiting.id,
      invoiceId: paid.id,
      purpose: 'topup',
      gatewayId,
      amount: '10.0000',
      currency: 'USD',
      status: 'pending',
      methodType: 'bank',
    });
    await expectBlocked(waiting.id, goldId, retailId, ['open_topup']);
  });

  it('does not block for an automatic top-up page nobody paid in a day, nor for a paid or void invoice', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '8' });
    const old = new Date('2026-11-05T12:00:00.000Z');
    await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'open', createdAt: old });
    await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'paid', createdAt: old });
    await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'void', createdAt: clock.now() });
    const res = await change(owner, account.id, retailId);
    expect(res.status).toBe(200);
    expect(res.body.movedAmount).toBe('8.0000');
  });

  it('open_dispute: a dispute of a top-up payment is still open', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '5' });
    const gatewayId = await insertGateway(t, db);
    const invoice = await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'paid' });
    const [payment] = await db
      .insert(s.payments)
      .values({
        accountId: account.id,
        invoiceId: invoice.id,
        purpose: 'topup',
        gatewayId,
        amount: '20.0000',
        currency: 'USD',
        status: 'approved',
        methodType: 'card',
      })
      .returning({ id: s.payments.id });
    await db.insert(s.disputes).values({
      paymentId: payment!.id,
      accountId: account.id,
      gatewayDisputeId: 'dp_rank_1',
      reasonCode: 'fraudulent',
      amount: '20.0000',
      currency: 'USD',
      status: 'under_review',
      evidenceDueAt: new Date('2026-11-20T00:00:00.000Z'),
    });
    await expectBlocked(account.id, goldId, retailId, ['open_dispute']);
  });

  it('open_refund: a refund to the store balance is still requested', async () => {
    const { goldId } = await ranks();
    const account = await retailWith('12');
    const { serviceId } = await insertOrderParents(db);
    const order = await insertOrderRow(db, { serviceId, accountId: account.id, source: 'store', status: 'completed' });
    const [payment] = await db
      .insert(s.payments)
      .values({
        accountId: account.id,
        orderId: order.id,
        purpose: 'order',
        amount: '10.0000',
        currency: 'USD',
        status: 'captured',
        methodType: 'balance',
      })
      .returning({ id: s.payments.id });
    await db.insert(s.refunds).values({
      paymentId: payment!.id,
      orderId: order.id,
      accountId: account.id,
      amount: '10.0000',
      currency: 'USD',
      method: 'original',
      status: 'requested',
      requestedByType: 'account',
      requestedById: account.id,
    });
    await expectBlocked(account.id, account.groupId, goldId, ['open_refund']);
  });

  it('frozen: a wallet of the account is on hold, the inactive one too', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '6' });
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: clock.now(), frozenReason: 'Checking a payment' })
      .where(and(eq(s.ledgerAccounts.ownerId, account.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    await expectBlocked(account.id, goldId, retailId, ['frozen']);

    const retail = await retailWith('4');
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: clock.now(), frozenReason: 'Chargeback' })
      .where(and(eq(s.ledgerAccounts.ownerId, retail.id), eq(s.ledgerAccounts.kind, 'customer_wallet')));
    await expectBlocked(retail.id, retail.groupId, goldId, ['frozen']);
  });

  it('negative_balance: the source wallet is below zero (credit in use)', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { creditLimit: '100' });
    await db
      .update(s.ledgerAccounts)
      .set({ balance: '-25' })
      .where(and(eq(s.ledgerAccounts.ownerId, account.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    await expectBlocked(account.id, goldId, retailId, ['negative_balance']);
  });

  it('lists every blocker together, in one order, when several apply, and writes nothing', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '50' });
    await placeOrderHold(db, account.id, '10');
    await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'open', createdAt: clock.now() });
    reported.set(account.id, ['open_checkout', 'live_order']);
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: clock.now(), frozenReason: 'Review' })
      .where(and(eq(s.ledgerAccounts.ownerId, account.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    await expectBlocked(account.id, goldId, retailId, [
      'open_hold',
      'live_order',
      'open_topup',
      'open_checkout',
      'frozen',
    ]);
    // The wallets that were opened to look are rolled back with the refusal.
    expect((await walletsOf(account.id)).has('customer_wallet')).toBe(false);
  });
});

describe('merchant to retail', () => {
  it('moves the whole balance to the store balance under rank:<id>:<key>, drops the credit limit and ends sessions and keys', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '42.5', creditLimit: '300' });
    await openAccountSession(t, account.id);
    await openAccountSession(t, account.id);
    await insertApiKey(t, db, account.id);
    const totalsBefore = await ledgerTotals(db);

    const res = await change(owner, account.id, retailId, 'key-one');
    expect(res.status).toBe(200);
    expect(res.res.headers['idempotency-replayed']).toBeUndefined();
    const transfers = await transfersOf(account.id);
    expect(transfers).toHaveLength(1);
    expect(res.body).toMatchObject({
      rank: { id: retailId, kind: 'retail' },
      movedAmount: '42.5000',
      transactionId: transfers[0]!.id,
      sessionsEnded: 2,
      apiKeysRevoked: 1,
      wallet: { kind: 'store', balance: '42.5000', creditLimit: '0.0000' },
    });
    expect(transfers[0]).toMatchObject({
      idempotencyKey: `rank:${account.id}:key-one`,
      refType: 'account',
      refId: account.id,
      createdByType: 'staff',
      createdById: owner.staffId,
    });
    expect(transfers[0]!.memo).toContain('rank change');

    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')).toMatchObject({ balance: '0.0000', overdraftLimit: '0.0000' });
    expect(wallets.get('customer_wallet')!.balance).toBe('42.5000');
    expect(wallets.get('client_hold')!.balance).toBe('0.0000');
    expect((await accountRow(account.id)).groupId).toBe(retailId);
    expect(await liveSessionsOf(account.id)).toBe(0);
    expect(await liveKeysOf(account.id)).toBe(0);
    // Money moved between two accounts of one owner: not one cent came or went.
    const totalsAfter = await ledgerTotals(db);
    expect(totalsAfter.sum).toBe('0.0000');
    expect(totalsAfter.transactions).toBe(totalsBefore.transactions + 1);
  });

  it('keeps the history of the change with the name and kind of both ranks, and one audit row', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '10' });
    await openAccountSession(t, account.id);
    expect((await change(owner, account.id, retailId, 'key-history')).status).toBe(200);
    const [row] = await historyOf(account.id);
    expect(row).toMatchObject({
      fromGroupId: goldId,
      fromGroupName: 'Gold',
      fromKind: 'merchant',
      toGroupId: retailId,
      toKind: 'retail',
      movedAmount: '10.0000',
      idempotencyKey: 'key-history',
      sessionsEnded: 1,
      apiKeysRevoked: 0,
      staffId: owner.staffId,
    });
    expect(row!.toGroupName.length).toBeGreaterThan(0);
    expect(row!.ledgerTransactionId).toBe((await transfersOf(account.id))[0]!.id);
    const audit = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityType, 'account'), eq(s.auditLogs.entityId, account.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: owner.staffId });
    expect(audit[0]!.after).toMatchObject({ kind: 'retail', movedAmount: '10.0000', sessionsEnded: 1 });
  });

  it('posts nothing for an empty wallet, and still changes the rank, the credit limit and the sessions', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { creditLimit: '75' });
    await openAccountSession(t, account.id);
    const res = await change(owner, account.id, retailId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ movedAmount: '0.0000', transactionId: null, sessionsEnded: 1 });
    expect(await transfersOf(account.id)).toHaveLength(0);
    expect((await walletsOf(account.id)).get('client_wallet')!.overdraftLimit).toBe('0.0000');
    expect((await historyOf(account.id))[0]).toMatchObject({ movedAmount: '0.0000', ledgerTransactionId: null });
  });
});

describe('retail to merchant', () => {
  it('opens the merchant wallet and its hold, moves the store balance, gives a username and queues an invitation for an account without a password', async () => {
    const { goldId } = await ranks();
    const account = await retailWith('30', { password: null });
    expect(account.row.username).toBeNull();
    await openAccountSession(t, account.id);
    const res = await change(owner, account.id, goldId, 'key-up');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rank: { id: goldId, name: 'Gold', kind: 'merchant' },
      movedAmount: '30.0000',
      sessionsEnded: 1,
      apiKeysRevoked: 0,
      wallet: { kind: 'merchant', balance: '30.0000' },
    });
    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')!.balance).toBe('30.0000');
    expect(wallets.has('client_hold')).toBe(true);
    expect(wallets.get('customer_wallet')!.balance).toBe('0.0000');
    const row = await accountRow(account.id);
    expect(row.groupId).toBe(goldId);
    expect(row.username).not.toBeNull();
    const invites = await db
      .select()
      .from(s.authTokens)
      .where(
        and(
          eq(s.authTokens.subjectType, 'account'),
          eq(s.authTokens.subjectId, account.id),
          eq(s.authTokens.purpose, 'invite'),
        ),
      );
    expect(invites).toHaveLength(1);
    expect((await transfersOf(account.id))[0]!.idempotencyKey).toBe(`rank:${account.id}:key-up`);
  });

  it('queues no invitation for an account that has a password', async () => {
    const { goldId } = await ranks();
    const account = await retailWith('0');
    expect((await change(owner, account.id, goldId)).status).toBe(200);
    const invites = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, account.id));
    expect(invites.filter((token) => token.purpose === 'invite')).toHaveLength(0);
  });
});

describe('inside the merchant kind', () => {
  it('changes only the rank: no wallet moves, no session ends, no key is revoked', async () => {
    const { goldId, basicId } = await ranks();
    const account = await merchantOf(goldId, { balance: '20' });
    await openAccountSession(t, account.id);
    await insertApiKey(t, db, account.id);
    const res = await change(owner, account.id, basicId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rank: { id: basicId, kind: 'merchant' },
      movedAmount: '0.0000',
      transactionId: null,
      sessionsEnded: 0,
      apiKeysRevoked: 0,
    });
    expect((await accountRow(account.id)).groupId).toBe(basicId);
    expect((await walletsOf(account.id)).get('client_wallet')!.balance).toBe('20.0000');
    expect(await liveSessionsOf(account.id)).toBe(1);
    expect(await liveKeysOf(account.id)).toBe(1);
    expect(await transfersOf(account.id)).toHaveLength(0);
    expect((await historyOf(account.id))[0]).toMatchObject({
      fromKind: 'merchant',
      toKind: 'merchant',
      movedAmount: '0.0000',
    });
  });

  it('refuses a rank without credit while the credit limit is above zero (credit_limit), and allows it at zero', async () => {
    const { goldId, basicId } = await ranks();
    const lent = await merchantOf(goldId, { creditLimit: '500' });
    const refused = await change(owner, lent.id, basicId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RANK_CHANGE_BLOCKED');
    expect(refused.body.errors.map((entry: { code: string }) => entry.code)).toEqual(['credit_limit']);
    expect((await accountRow(lent.id)).groupId).toBe(goldId);
    expect(await historyOf(lent.id)).toHaveLength(0);

    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '0' })
      .where(and(eq(s.ledgerAccounts.ownerId, lent.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    expect((await change(owner, lent.id, basicId)).status).toBe(200);
  });
});

describe('the key of a request', () => {
  it('answers the recorded change again for the same key and body, with idempotency-replayed, and posts nothing twice', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '15' });
    await openAccountSession(t, account.id);
    const first = await change(owner, account.id, retailId, 'key-replay');
    expect(first.status).toBe(200);
    const again = await change(owner, account.id, retailId, 'key-replay');
    expect(again.status).toBe(200);
    expect(again.res.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toMatchObject({
      rank: first.body.rank,
      movedAmount: '15.0000',
      transactionId: first.body.transactionId,
      sessionsEnded: first.body.sessionsEnded,
      apiKeysRevoked: first.body.apiKeysRevoked,
    });
    expect(await historyOf(account.id)).toHaveLength(1);
    expect(await transfersOf(account.id)).toHaveLength(1);
    expect((await walletsOf(account.id)).get('customer_wallet')!.balance).toBe('15.0000');
    // The replayed staff request is audited too, as one more row that moves nothing.
    const audits = await db
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, account.id))
      .orderBy(asc(s.auditLogs.id));
    expect(audits.map((row) => row.action)).toEqual(['changed rank of', 'repeated rank change of']);
  });

  it('refuses the same key for another rank with IDEMPOTENCY_KEY_REUSED and changes nothing more', async () => {
    const { retailId, goldId, basicId } = await ranks();
    const account = await merchantOf(goldId, { balance: '15' });
    expect((await change(owner, account.id, retailId, 'key-reused')).status).toBe(200);
    const other = await change(owner, account.id, basicId, 'key-reused');
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect((await accountRow(account.id)).groupId).toBe(retailId);
    expect(await historyOf(account.id)).toHaveLength(1);
  });

  it('is scoped to the account: the same key may change another account', async () => {
    const { retailId, goldId } = await ranks();
    const one = await merchantOf(goldId, { balance: '1' });
    const two = await merchantOf(goldId, { balance: '2' });
    expect((await change(owner, one.id, retailId, 'shared-key')).status).toBe(200);
    expect((await change(owner, two.id, retailId, 'shared-key')).status).toBe(200);
    expect((await transfersOf(one.id))[0]!.idempotencyKey).toBe(`rank:${one.id}:shared-key`);
    expect((await transfersOf(two.id))[0]!.idempotencyKey).toBe(`rank:${two.id}:shared-key`);
  });
});

describe('a chain of changes and the history', () => {
  it('retail, merchant, retail, merchant with three keys posts three transactions and keeps three history rows', async () => {
    const { retailId, goldId } = await ranks();
    const account = await retailWith('30');
    const keys = ['chain-1', 'chain-2', 'chain-3'];
    expect((await change(owner, account.id, goldId, keys[0])).status).toBe(200);
    expect((await change(owner, account.id, retailId, keys[1])).status).toBe(200);
    expect((await change(owner, account.id, goldId, keys[2])).status).toBe(200);
    const transfers = await transfersOf(account.id);
    expect(transfers.map((row) => row.idempotencyKey)).toEqual(keys.map((key) => `rank:${account.id}:${key}`));
    expect((await historyOf(account.id)).map((row) => [row.fromKind, row.toKind, row.movedAmount])).toEqual([
      ['retail', 'merchant', '30.0000'],
      ['merchant', 'retail', '30.0000'],
      ['retail', 'merchant', '30.0000'],
    ]);
    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')!.balance).toBe('30.0000');
    expect(wallets.get('customer_wallet')!.balance).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('keeps both ranks readable in the history after a rank is deleted, and the delete is not refused because of the history', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, { balance: '9' });
    expect((await change(owner, account.id, retailId, 'key-deleted')).status).toBe(200);
    // Nobody holds Gold now, so the ranks admin may delete it; the history row carries no foreign key to it.
    expect((await owner.delete(`/admin/client-groups/${goldId}`)).status).toBe(204);
    const [row] = await historyOf(account.id);
    expect(row).toMatchObject({ fromGroupId: goldId, fromGroupName: 'Gold', fromKind: 'merchant' });
  });
});
