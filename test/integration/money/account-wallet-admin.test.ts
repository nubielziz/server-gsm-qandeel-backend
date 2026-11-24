// Integration tests of the wallet of an account at one address (decision 064): GET /admin/clients/:id/wallet and /statement,
// POST /admin/clients/:id/wallet/adjust, PATCH /admin/clients/:id/credit-limit and POST /admin/clients/:id/wallet/freeze and /unfreeze, for a
// merchant-rank account and a retail account, through HTTP on the real application. Decision 049: the approval limit of each wallet kind caps
// a staff member's credits over 24 hours (a debit alone, an Owner exempt). Freeze, unfreeze and credit limit carry a required
// Idempotency-Key that is stored and replayed, and a replay never applies the change twice.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { customerAdjust, deposit, postTransaction } from '@src/modules/money';
import { walletBalanceSql } from '@src/modules/money/infra/account-wallet-sql';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { type AccountOverrides, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type AdminApi, adminFor, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  pushNegative,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { mapLegacyCustomer } from '../../support/legacy-accounts';
import { accountFigures, fundWallet, insertWalletMerchant } from '../../support/money';
import { CONSOLE_ORIGIN } from '../../support/staff-console';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;
let reader: AdminApi;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['wallet:read', 'wallet:adjust', 'wallet:credit_limit'], { name: 'Rami K.' });
  reader = await adminWith(t, ['ledger:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** One `Idempotency-Key` header. */
const key = (value: string = crypto.randomUUID()) => ({ 'idempotency-key': value });
const adjustBody = (overrides: Record<string, unknown> = {}) => ({
  amount: '10.0000',
  direction: 'credit',
  reason: 'Goodwill credit for a failed order',
  ...overrides,
});
const walletUrl = (accountId: number) => `/admin/clients/${accountId}/wallet`;

/** A retail account (the store balance is its wallet). */
const retail = (values: Omit<AccountOverrides, 'rank'> = {}) =>
  makeAccount({ rank: 'retail', name: 'Daniel Rivera', ...values });

async function auditOf(accountId: number) {
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'account'), eq(s.auditLogs.entityId, accountId)))
    .orderBy(s.auditLogs.id);
}

async function keysOf(accountId: number) {
  return db
    .select()
    .from(s.walletActionKeys)
    .where(eq(s.walletActionKeys.accountId, accountId))
    .orderBy(s.walletActionKeys.id);
}

async function journalsOf(idempotencyKey: string) {
  return db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.idempotencyKey, idempotencyKey));
}

/**
 * Posts a store credit the way the release before the accounts merged did: the old reference word `customer` and the old key form. The table
 * refuses an old word in a new row (the current check is NOT VALID: it guards new rows only), so the check is dropped and added back the same
 * way inside one transaction.
 */
async function postOldStoreCredit(input: {
  accountId: number;
  oldCustomerId: number;
  amount: string;
  staffId: number;
  key: string;
  memo: string;
}): Promise<number> {
  const words = sql.raw(s.CURRENT_LEDGER_REF_TYPES.map((word) => `'${word}'`).join(', '));
  return db.transaction(async (tx) => {
    await tx.execute(sql`alter table ledger_transactions drop constraint ledger_transactions_ref_type_current_check`);
    const posted = await postTransaction(
      tx,
      {
        ...customerAdjust({ customerId: input.accountId, amount: Money.of(input.amount), direction: 'credit' }),
        refType: 'customer',
        refId: input.oldCustomerId,
        idempotencyKey: input.key,
        currency: 'USD',
        memo: input.memo,
        createdBy: { type: 'staff', id: input.staffId },
      },
      clock.now(),
    );
    await tx.execute(
      sql`alter table ledger_transactions add constraint ledger_transactions_ref_type_current_check check (ref_type in (${words})) not valid`,
    );
    return posted.id;
  });
}

describe('GET /admin/clients/:id/wallet', () => {
  it('answers the merchant wallet with its four figures, the credit facts and kind merchant', async () => {
    const merchant = await insertWalletMerchant(db, { creditLimit: '2000' });
    await fundWallet(db, merchant.id, '120.5');
    const res = await staff.get(walletUrl(merchant.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'merchant',
      currency: 'USD',
      balance: '120.5000',
      reserved: '0.0000',
      creditLimit: '2000.0000',
      available: '2120.5000',
      creditAllowed: true,
      frozen: null,
      enabled: true,
      openDisputes: 0,
      adjustApprovalLimit: '10000.0000',
    });
  });

  it('answers the store balance of a retail account with kind store, no reserve and no credit', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '42.50');
    expect((await staff.get(walletUrl(buyer.id))).body).toMatchObject({
      kind: 'store',
      balance: '42.5000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '42.5000',
      creditAllowed: false,
      enabled: true,
      adjustApprovalLimit: '500.0000',
    });
  });

  it('answers zeros for an account without a wallet and for a guest, and reads fresh figures every time', async () => {
    const buyer = await retail();
    const guest = await retail({ guest: true });
    const empty = await staff.get(walletUrl(buyer.id));
    expect(empty.body).toEqual({
      kind: 'store',
      currency: 'USD',
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
      creditAllowed: false,
      frozen: null,
      enabled: true,
      pendingTopUps: { count: 0, amount: '0.0000' },
      openDisputes: 0,
      adjustApprovalLimit: '500.0000',
    });
    expect((await staff.get(walletUrl(guest.id))).body).toMatchObject({ kind: 'store', balance: '0.0000' });
    await fundCustomer(db, buyer.id, '5');
    expect((await staff.get(walletUrl(buyer.id))).body.balance).toBe('5.0000');
  });

  it('answers 404 for an unknown account, 422 for a bad id, 403 without wallet:read and 401 without a session', async () => {
    const buyer = await retail();
    expect((await staff.get(walletUrl(999_999))).body.code).toBe('NOT_FOUND');
    expect((await staff.get('/admin/clients/abc/wallet')).status).toBe(422);
    expect((await reader.get(walletUrl(buyer.id))).body.code).toBe('FORBIDDEN');
    expect((await staff.anonymous('GET', walletUrl(buyer.id))).status).toBe(401);
  });
});

describe('GET /admin/clients/:id/statement', () => {
  it('lists the store lines newest first with the full memo, filters by the posting window and counts', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '30', clock.now());
    clock.advance(10 * 60_000);
    await staff.post(
      `${walletUrl(buyer.id)}/adjust`,
      adjustBody({ amount: '5.0000', direction: 'debit', reason: 'Internal note here' }),
      key(),
    );
    const page = await staff.get(`/admin/clients/${buyer.id}/statement`);
    expect(page.status).toBe(200);
    expect(page.total).toBe(2);
    expect(page.body[0]).toMatchObject({
      kind: 'adjustment',
      memo: 'Manual debit: Internal note here',
      orderId: null,
      amount: '-5.0000',
      balanceAfter: '25.0000',
    });
    expect(page.body[1]).toMatchObject({ kind: 'deposit', amount: '30.0000', balanceAfter: '30.0000' });
    const later = await staff.get(`/admin/clients/${buyer.id}/statement?createdAt_gte=2026-11-10T09:05:00.000Z`);
    expect(later.total).toBe(1);
    expect((await staff.get('/admin/clients/999999/statement')).status).toBe(404);
  });

  it('lists the merchant wallet lines from the account side, the window too', async () => {
    const merchant = await insertWalletMerchant(db);
    // The deposit is posted at the test clock's time, so the window below can find it (fundWallet posts at the real time).
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...deposit({ clientId: merchant.id, amount: Money.of('100') }),
          refId: 1,
          idempotencyKey: 'fund:window',
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    clock.advance(10 * 60_000);
    await staff.post(`${walletUrl(merchant.id)}/adjust`, adjustBody({ amount: '10.0000' }), key());
    const page = await staff.get(`/admin/clients/${merchant.id}/statement`);
    expect(page.total).toBe(2);
    expect(page.body.map((row: Record<string, unknown>) => [row.kind, row.amount, row.balanceAfter])).toEqual([
      ['adjustment', '10.0000', '110.0000'],
      ['deposit', '100.0000', '100.0000'],
    ]);
    const window = await staff.get(`/admin/clients/${merchant.id}/statement?createdAt_lte=2026-11-10T09:05:00.000Z`);
    expect(window.total).toBe(1);
  });

  it('reads the history of the wallet an account left behind with wallet=merchant, and the live one by default', async () => {
    const former = await insertWalletMerchant(db);
    await fundWallet(db, former.id, '40');
    // The rank moved to the retail kind (the rank change itself is the money module's other route): the live wallet is the store balance now.
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, former.id));
    const live = await staff.get(`/admin/clients/${former.id}/statement`);
    expect(live.total).toBe(0);
    expect((await staff.get(walletUrl(former.id))).body.kind).toBe('store');
    const history = await staff.get(`/admin/clients/${former.id}/statement?wallet=merchant`);
    expect(history.total).toBe(1);
    expect(history.body[0]).toMatchObject({ kind: 'deposit', amount: '40.0000' });
    expect((await staff.get(`/admin/clients/${former.id}/statement?wallet=other`)).status).toBe(422);
  });
});

describe('POST /admin/clients/:id/wallet/adjust', () => {
  it('posts on a merchant wallet under adjust:<accountId>:<key>, with the reference type account, and audits it as an account', async () => {
    const merchant = await insertWalletMerchant(db);
    const res = await staff.post(`${walletUrl(merchant.id)}/adjust`, adjustBody(), key('dialog-1'));
    expect(res.status).toBe(200);
    expect(res.body.wallet).toMatchObject({ kind: 'merchant', balance: '10.0000' });
    const [journal] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.id, res.body.transactionId));
    expect(journal).toMatchObject({
      kind: 'adjustment',
      refType: 'account',
      refId: merchant.id,
      idempotencyKey: `adjust:${merchant.id}:dialog-1`,
      createdByType: 'staff',
      createdById: staff.staffId,
      memo: 'Manual credit: Goodwill credit for a failed order',
    });
    const audits = await auditOf(merchant.id);
    expect(audits.map((row) => row.action)).toEqual(['adjusted wallet of']);
    expect(audits[0]).toMatchObject({ entityLabel: 'Test Merchant', before: { kind: 'merchant', balance: '0.0000' } });
    expect(audits[0]!.after).toMatchObject({ balance: '10.0000', amount: '10.0000', direction: 'credit' });
  });

  it('posts on a store balance under the same key form, audits it as an account and mails the customer once', async () => {
    const buyer = await retail();
    const res = await staff.post(`${walletUrl(buyer.id)}/adjust`, adjustBody(), key('dialog-2'));
    expect(res.status).toBe(200);
    expect(res.body.wallet).toMatchObject({ kind: 'store', balance: '10.0000', available: '10.0000' });
    const [journal] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.id, res.body.transactionId));
    expect(journal).toMatchObject({
      refType: 'account',
      refId: buyer.id,
      idempotencyKey: `adjust:${buyer.id}:dialog-2`,
    });
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
    expect((await auditOf(buyer.id)).map((row) => row.action)).toEqual(['adjusted wallet of']);
    const mails = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.recipientId, buyer.id), eq(s.notifications.event, 'wallet.adjusted')));
    expect(mails).toHaveLength(1);
  });

  it('needs the Idempotency-Key for both kinds: 422 without it, nothing posted', async () => {
    const merchant = await insertWalletMerchant(db);
    const buyer = await retail();
    for (const id of [merchant.id, buyer.id]) {
      const res = await staff.post(`${walletUrl(id)}/adjust`, adjustBody());
      expect(res.status).toBe(422);
    }
    expect(
      (await staff.post(`${walletUrl(buyer.id)}/adjust`, adjustBody(), { 'idempotency-key': 'has space' })).status,
    ).toBe(422);
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id })).toMatchObject({
      balance: '0.0000',
    });
    expect(await customerWalletRow(db, buyer.id)).toBeUndefined();
  });

  it('answers a retry of the same key and body with the first journal and posts nothing again, for both kinds', async () => {
    const merchant = await insertWalletMerchant(db);
    const buyer = await retail();
    for (const account of [merchant, buyer]) {
      const url = `${walletUrl(account.id)}/adjust`;
      const first = await staff.post(url, adjustBody(), key('same'));
      const again = await staff.post(url, adjustBody(), key('same'));
      expect(again.status).toBe(200);
      expect(again.body.transactionId).toBe(first.body.transactionId);
      expect(again.res.headers['idempotency-replayed']).toBe('true');
      expect(first.res.headers['idempotency-replayed']).toBeUndefined();
      expect(await journalsOf(`adjust:${account.id}:same`)).toHaveLength(1);
      expect((await auditOf(account.id)).map((row) => row.action)).toEqual([
        'adjusted wallet of',
        'repeated wallet adjustment of',
      ]);
    }
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('refuses the same key with another amount, direction or reason', async () => {
    const buyer = await retail();
    const url = `${walletUrl(buyer.id)}/adjust`;
    await staff.post(url, adjustBody(), key('K'));
    for (const other of [{ amount: '11.0000' }, { direction: 'debit' }, { reason: 'Another reason entirely' }]) {
      const reused = await staff.post(url, adjustBody(other), key('K'));
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
  });

  it('replays across a rank change: the key made on the merchant wallet answers the first journal after the rank turned retail', async () => {
    const merchant = await insertWalletMerchant(db);
    const url = `${walletUrl(merchant.id)}/adjust`;
    const first = await staff.post(url, adjustBody(), key('crossing'));
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, merchant.id));
    const again = await staff.post(url, adjustBody(), key('crossing'));
    expect(again.status).toBe(200);
    expect(again.body.transactionId).toBe(first.body.transactionId);
    expect(await journalsOf(`adjust:${merchant.id}:crossing`)).toHaveLength(1);
    expect(await customerWalletRow(db, merchant.id)).toBeUndefined();
  });

  it('replays a retry of a store adjustment made before the release (key adjust:customer:<oldId>:<k>)', async () => {
    const buyer = await retail();
    await mapLegacyCustomer(db, 9001, buyer.id);
    const memo = 'Manual credit: Goodwill credit for a failed order';
    const old = await postOldStoreCredit({
      accountId: buyer.id,
      oldCustomerId: 9001,
      amount: '10.0000',
      staffId: staff.staffId,
      key: 'adjust:customer:9001:old-dialog',
      memo,
    });
    const url = `${walletUrl(buyer.id)}/adjust`;
    const retry = await staff.post(url, adjustBody(), key('old-dialog'));
    expect(retry.status).toBe(200);
    expect(retry.body.transactionId).toBe(old);
    expect(retry.res.headers['idempotency-replayed']).toBe('true');
    expect(await journalsOf(`adjust:${buyer.id}:old-dialog`)).toHaveLength(0);
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
    // Another body under the old key is refused, not posted.
    const reused = await staff.post(url, adjustBody({ amount: '12.0000' }), key('old-dialog'));
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
  });

  it('refuses a merchant debit below the credit limit and a store debit below zero', async () => {
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '10');
    const merchantDebit = await staff.post(
      `${walletUrl(merchant.id)}/adjust`,
      adjustBody({ amount: '100.0001', direction: 'debit' }),
      key(),
    );
    expect(merchantDebit.status).toBe(409);
    expect(merchantDebit.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
    const storeDebit = await staff.post(
      `${walletUrl(buyer.id)}/adjust`,
      adjustBody({ amount: '10.0001', direction: 'debit' }),
      key(),
    );
    expect(storeDebit.status).toBe(402);
    expect(storeDebit.body.code).toBe('INSUFFICIENT_FUNDS');
    const exact = await staff.post(
      `${walletUrl(buyer.id)}/adjust`,
      adjustBody({ amount: '10.0000', direction: 'debit' }),
      key(),
    );
    expect(exact.body.wallet.balance).toBe('0.0000');
  });

  it('refuses a store credit to a guest and to an anonymized account, but not a merchant credit for any status', async () => {
    const guest = await retail({ guest: true });
    const gone = await retail({ status: 'anonymized', hasAccount: false, anonymizedAt: clock.now() });
    expect((await staff.post(`${walletUrl(guest.id)}/adjust`, adjustBody(), key())).body.code).toBe('NO_ACCOUNT');
    expect((await staff.post(`${walletUrl(gone.id)}/adjust`, adjustBody(), key())).body.code).toBe('ANONYMIZED');
    const suspended = await insertWalletMerchant(db);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, suspended.id));
    expect((await staff.post(`${walletUrl(suspended.id)}/adjust`, adjustBody(), key())).status).toBe(200);
  });

  it('judges the pools by wallet kind: a merchant credit over $10,000 and a store credit over $500 within 24 hours need an owner', async () => {
    const merchant = await insertWalletMerchant(db);
    const buyer = await retail();
    const other = await retail({ name: 'Second buyer' });
    const credit = (id: number, amount: string, api: AdminApi = staff) =>
      api.post(`${walletUrl(id)}/adjust`, adjustBody({ amount }), key());
    expect((await credit(merchant.id, '9000.0000')).status).toBe(200);
    // The merchant credits are a pool of their own: they do not count against the store limit.
    expect((await credit(buyer.id, '300.0000')).status).toBe(200);
    expect((await credit(other.id, '200.0000')).status).toBe(200);
    const store = await credit(buyer.id, '0.0001');
    expect(store.status).toBe(409);
    expect(store.body).toMatchObject({
      code: 'APPROVAL_REQUIRED',
      detail: 'Credits over $500 in 24 hours need an owner: yours would come to $500.0001.',
    });
    expect((await credit(merchant.id, '1000.0001')).body.code).toBe('APPROVAL_REQUIRED');
    expect((await credit(merchant.id, '1000.0000')).status).toBe(200);
    const owner = await adminWith(t, ['*']);
    expect((await credit(buyer.id, '600.0000', owner)).status).toBe(200);
    // Another staff member's credits are their own.
    const colleague = await adminWith(t, ['wallet:read', 'wallet:adjust']);
    expect((await credit(other.id, '500.0000', colleague)).status).toBe(200);
  });

  it('counts a store credit made before the release (ref type customer) in the 24 hours of the store pool', async () => {
    const buyer = await retail();
    await mapLegacyCustomer(db, 9002, buyer.id);
    await postOldStoreCredit({
      accountId: buyer.id,
      oldCustomerId: 9002,
      amount: '300.0000',
      staffId: staff.staffId,
      key: 'adjust:customer:9002:before',
      memo: 'Manual credit: Before the release',
    });
    const url = `${walletUrl(buyer.id)}/adjust`;
    const over = await staff.post(url, adjustBody({ amount: '200.0001' }), key());
    expect(over.body.code).toBe('APPROVAL_REQUIRED');
    expect(over.body.detail).toBe('Credits over $500 in 24 hours need an owner: yours would come to $500.0001.');
    expect((await staff.post(url, adjustBody({ amount: '200.0000' }), key())).status).toBe(200);
    // After the 24 hours the credits stop counting. A staff session does not last a day: the same member signs in again.
    clock.advance(25 * 3_600_000);
    const later = await adminFor(t, staff.staffId, staff.roleId);
    expect((await later.post(url, adjustBody({ amount: '500.0000' }), key())).status).toBe(200);
  });

  it('never overspends a store balance under parallel debits of different keys', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '100');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        staff.post(`${walletUrl(buyer.id)}/adjust`, adjustBody({ amount: '30.0000', direction: 'debit' }), key()),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(3);
    expect(results.filter((result) => result.status !== 200).every((result) => result.status === 402)).toBe(true);
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('needs wallet:adjust: 403 for a reader, 401 without a session, 404 for an unknown account', async () => {
    const buyer = await retail();
    expect((await reader.post(`${walletUrl(buyer.id)}/adjust`, adjustBody(), key())).body.code).toBe('FORBIDDEN');
    expect((await staff.anonymous('POST', `${walletUrl(buyer.id)}/adjust`, adjustBody())).status).toBe(401);
    expect((await staff.post(`${walletUrl(999_999)}/adjust`, adjustBody(), key())).status).toBe(404);
  });
});

describe('PATCH /admin/clients/:id/credit-limit', () => {
  const patch = (id: number, creditLimit: string, headers: Record<string, string> = key(), api: AdminApi = staff) =>
    api.call('PATCH', `/admin/clients/${id}/credit-limit`, { creditLimit }, headers);

  it('sets the limit of a merchant wallet, records a raise and audits it, once per key', async () => {
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    const first = await patch(merchant.id, '2000.0000', key('limit-1'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: 'merchant', creditLimit: '2000.0000', available: '2000.0000' });
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id })).toMatchObject({
      overdraftLimit: '2000.0000',
    });
    const raises = await db.select().from(s.creditLimitRaises).where(eq(s.creditLimitRaises.clientId, merchant.id));
    expect(raises).toHaveLength(1);
    expect(raises[0]).toMatchObject({ amount: '2000.0000', staffId: staff.staffId });
    expect((await auditOf(merchant.id)).map((row) => row.action)).toEqual(['changed credit limit of']);

    const again = await patch(merchant.id, '2000.0000', key('limit-1'));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.res.headers['idempotency-replayed']).toBe('true');
    expect(
      await db.select().from(s.creditLimitRaises).where(eq(s.creditLimitRaises.clientId, merchant.id)),
    ).toHaveLength(1);
    // The replay is audited as a repeat; the change itself was audited once.
    expect((await auditOf(merchant.id)).map((row) => row.action)).toEqual([
      'changed credit limit of',
      'repeated credit limit change of',
    ]);
    expect(await keysOf(merchant.id)).toHaveLength(1);
  });

  it('answers the first result again for a replay made after the limit changed, and refuses the key with another body', async () => {
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    await patch(merchant.id, '2000.0000', key('A'));
    await patch(merchant.id, '500.0000', key('B'));
    const replay = await patch(merchant.id, '2000.0000', key('A'));
    expect(replay.body.creditLimit).toBe('2000.0000');
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id })).toMatchObject({
      overdraftLimit: '500.0000',
    });
    const reused = await patch(merchant.id, '700.0000', key('A'));
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const reusedForFreeze = await staff.post(
      `${walletUrl(merchant.id)}/freeze`,
      { reason: 'Same key other action' },
      key('A'),
    );
    expect(reusedForFreeze.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('needs the Idempotency-Key: 422 without it, nothing written', async () => {
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    expect((await patch(merchant.id, '2000.0000', {})).status).toBe(422);
    expect(await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id })).toMatchObject({
      overdraftLimit: '0.0000',
    });
    expect(await keysOf(merchant.id)).toHaveLength(0);
  });

  it('refuses a credit limit on a store balance with 422 on creditLimit and stores no key', async () => {
    const buyer = await retail();
    const res = await patch(buyer.id, '100.0000');
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      { field: 'creditLimit', code: 'not_allowed', message: 'A store balance has no credit limit.' },
    ]);
    expect(await keysOf(buyer.id)).toHaveLength(0);
  });

  it('refuses a limit on a rank without credit, and a raise above the approval limit for anyone but an Owner', async () => {
    const noCredit = await insertWalletMerchant(db, { overdraftAllowed: false });
    expect((await patch(noCredit.id, '1.0000')).body.errors[0]).toMatchObject({
      field: 'creditLimit',
      code: 'not_allowed',
    });
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    expect((await patch(merchant.id, '10000.0001')).body.code).toBe('FORBIDDEN');
    const owner = await adminWith(t, ['*']);
    expect((await patch(merchant.id, '10000.0001', key(), owner)).status).toBe(200);
    // Lowering never needs an owner.
    expect((await patch(merchant.id, '5.0000')).status).toBe(200);
  });

  it('takes no raise on a wallet that is on hold, and lets the limit come down', async () => {
    const merchant = await insertWalletMerchant(db, { creditLimit: '1000' });
    expect((await staff.post(`${walletUrl(merchant.id)}/freeze`, { reason: 'Checking a payment' }, key())).status).toBe(
      200,
    );
    const raise = await patch(merchant.id, '1500.0000');
    expect(raise.status).toBe(409);
    expect(raise.body.code).toBe('WALLET_FROZEN');
    const lower = await patch(merchant.id, '100.0000');
    expect(lower.status).toBe(200);
    expect(lower.body).toMatchObject({ creditLimit: '100.0000', frozen: { reason: 'Checking a payment' } });
  });

  it('needs wallet:credit_limit and a known account', async () => {
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    const adjuster = await adminWith(t, ['wallet:read', 'wallet:adjust']);
    expect((await patch(merchant.id, '1.0000', key(), adjuster)).body.code).toBe('FORBIDDEN');
    expect((await patch(999_999, '1.0000')).status).toBe(404);
  });
});

describe('POST /admin/clients/:id/wallet/freeze and /unfreeze', () => {
  it('freezes and unfreezes a merchant wallet , audits both and answers the wallet with its hold', async () => {
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    await fundWallet(db, merchant.id, '20');
    const url = walletUrl(merchant.id);
    const frozen = await staff.post(`${url}/freeze`, { reason: 'Checking a payment' }, key('f1'));
    expect(frozen.status).toBe(200);
    expect(frozen.body).toMatchObject({
      kind: 'merchant',
      balance: '20.0000',
      frozen: { at: '2026-11-10T09:00:00.000Z', reason: 'Checking a payment' },
    });
    const [held] = await db
      .select({ frozenAt: s.ledgerAccounts.frozenAt, frozenReason: s.ledgerAccounts.frozenReason })
      .from(s.ledgerAccounts)
      .where(and(eq(s.ledgerAccounts.kind, 'client_wallet'), eq(s.ledgerAccounts.ownerId, merchant.id)));
    expect(held).toMatchObject({ frozenReason: 'Checking a payment' });
    expect(held?.frozenAt).not.toBeNull();
    // A staff adjustment still posts on a wallet on hold.
    expect(
      (await staff.post(`${url}/adjust`, adjustBody({ amount: '5.0000', direction: 'debit' }), key())).status,
    ).toBe(200);
    const lifted = await staff.post(`${url}/unfreeze`, { reason: 'All clear now' }, key('u1'));
    expect(lifted.body).toMatchObject({ kind: 'merchant', frozen: null, balance: '15.0000' });
    expect((await auditOf(merchant.id)).map((row) => row.action)).toEqual([
      'froze wallet of',
      'adjusted wallet of',
      'unfroze wallet of',
    ]);
  });

  it('freezes a store balance once (a second freeze changes nothing), mails once, and unfreezes', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '20');
    const url = walletUrl(buyer.id);
    const frozen = await staff.post(`${url}/freeze`, { reason: 'Checking a payment' }, key());
    expect(frozen.body).toMatchObject({
      kind: 'store',
      available: '0.0000',
      frozen: { at: '2026-11-10T09:00:00.000Z', reason: 'Checking a payment' },
    });
    clock.advance(60_000);
    const twice = await staff.post(`${url}/freeze`, { reason: 'Another reason' }, key());
    expect(twice.body.frozen).toEqual({ at: '2026-11-10T09:00:00.000Z', reason: 'Checking a payment' });
    const mails = await db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.recipientId, buyer.id), eq(s.notifications.event, 'wallet.frozen')));
    expect(mails).toHaveLength(1);
    const audits = await auditOf(buyer.id);
    expect(audits.map((row) => row.action)).toEqual(['froze wallet of', 'froze wallet of']);
    expect(audits[1]!.after).toMatchObject({ alreadyFrozen: true });
    const lifted = await staff.post(`${url}/unfreeze`, { reason: 'All clear now' }, key());
    expect(lifted.body).toMatchObject({ frozen: null, balance: '20.0000', available: '20.0000' });
  });

  it('freezes an account that has no wallet yet, of either kind, and needs the key and a reason', async () => {
    const buyer = await retail();
    const merchant = await insertWalletMerchant(db);
    await db
      .delete(s.ledgerAccounts)
      .where(and(eq(s.ledgerAccounts.ownerType, 'account'), eq(s.ledgerAccounts.ownerId, merchant.id)));
    const url = walletUrl(buyer.id);
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold' }, key())).status).toBe(422);
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold the wallet' })).status).toBe(422);
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold the wallet' }, key())).body.frozen.reason).toBe(
      'Hold the wallet',
    );
    expect(
      (await staff.post(`${walletUrl(merchant.id)}/freeze`, { reason: 'Hold the wallet' }, key())).body,
    ).toMatchObject({
      kind: 'merchant',
      frozen: { reason: 'Hold the wallet' },
    });
    expect((await staff.post('/admin/clients/999999/wallet/freeze', { reason: 'Hold the wallet' }, key())).status).toBe(
      404,
    );
  });

  it('answers the first result for a replayed key and changes nothing, also after a later unfreeze', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '20');
    const url = walletUrl(buyer.id);
    const body = { reason: 'Checking a payment' };
    const first = await staff.post(`${url}/freeze`, body, key('freeze-1'));
    await staff.post(`${url}/unfreeze`, { reason: 'All clear now' }, key('unfreeze-1'));
    const retried = await staff.post(`${url}/freeze`, body, key('freeze-1'));
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(first.body);
    expect(retried.res.headers['idempotency-replayed']).toBe('true');
    // The wallet is not held again: the retried freeze changed nothing.
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ frozenAt: null, frozenReason: '' });
    expect((await auditOf(buyer.id)).map((row) => row.action)).toEqual([
      'froze wallet of',
      'unfroze wallet of',
      'repeated wallet freeze of',
    ]);
    expect((await keysOf(buyer.id)).map((row) => [row.action, row.idempotencyKey])).toEqual([
      ['freeze', 'freeze-1'],
      ['unfreeze', 'unfreeze-1'],
    ]);
    // The same key with another body is refused.
    const reused = await staff.post(`${url}/freeze`, { reason: 'A different reason' }, key('freeze-1'));
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('applies two parallel requests with one new key once: one answers, the other replays it', async () => {
    const buyer = await retail();
    const url = `${walletUrl(buyer.id)}/freeze`;
    const results = await Promise.all([
      staff.post(url, { reason: 'Checking a payment' }, key('race')),
      staff.post(url, { reason: 'Checking a payment' }, key('race')),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expect(results.filter((result) => result.res.headers['idempotency-replayed'] === 'true')).toHaveLength(1);
    expect(await keysOf(buyer.id)).toHaveLength(1);
    // One freeze applied; the request that lost the race answered the stored result and was audited as a repeat.
    expect((await auditOf(buyer.id)).map((row) => row.action)).toEqual([
      'froze wallet of',
      'repeated wallet freeze of',
    ]);
  });

  it('refuses to unfreeze a store balance below zero, and leaves the key unused', async () => {
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '10');
    await pushNegative(db, buyer.id, '25');
    const refused = await staff.post(`${walletUrl(buyer.id)}/unfreeze`, { reason: 'Try to lift' }, key('try'));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '-15.0000', frozenReason: 'Chargeback' });
    expect(await keysOf(buyer.id)).toHaveLength(0);
  });

  it('unfreezing a wallet that is not on hold changes nothing and says so in the audit row', async () => {
    const merchant = await insertWalletMerchant(db);
    const res = await staff.post(`${walletUrl(merchant.id)}/unfreeze`, { reason: 'Nothing is held' }, key());
    expect(res.status).toBe(200);
    expect(res.body.frozen).toBeNull();
    expect((await auditOf(merchant.id))[0]!.after).toMatchObject({ alreadyUnfrozen: true });
  });

  it('works on the wallet that is live after a rank change: a freeze after merchant to retail lands on the store balance', async () => {
    const account = await insertWalletMerchant(db);
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, account.id));
    const frozen = await staff.post(`${walletUrl(account.id)}/freeze`, { reason: 'After the crossing' }, key());
    expect(frozen.body).toMatchObject({ kind: 'store', frozen: { reason: 'After the crossing' } });
    expect(await customerWalletRow(db, account.id)).toMatchObject({ frozenReason: 'After the crossing' });
    // The merchant wallet the rank left behind is untouched.
    const [left] = await db
      .select({ frozenAt: s.ledgerAccounts.frozenAt })
      .from(s.ledgerAccounts)
      .where(and(eq(s.ledgerAccounts.kind, 'client_wallet'), eq(s.ledgerAccounts.ownerId, account.id)));
    expect(left?.frozenAt).toBeNull();
  });

  it('needs wallet:adjust: 403 for a reader and 401 without a session', async () => {
    const buyer = await retail();
    expect((await reader.post(`${walletUrl(buyer.id)}/freeze`, { reason: 'Hold the wallet' }, key())).body.code).toBe(
      'FORBIDDEN',
    );
    expect((await staff.anonymous('POST', `${walletUrl(buyer.id)}/unfreeze`, { reason: 'Lift the hold' })).status).toBe(
      401,
    );
  });
});

describe('the balance fragment of the account list (walletBalanceSql)', () => {
  const balanceOf = async (accountId: number): Promise<string> => {
    const result = await db.execute<{ balance: string }>(
      sql`select (${walletBalanceSql(sql`c.id`)})::text as balance from clients c where c.id = ${accountId}`,
    );
    return result.rows[0]!.balance;
  };

  it('reads the balance of the wallet of the kind of the rank, and zero for an account without a wallet', async () => {
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '120.5');
    const buyer = await retail();
    await fundCustomer(db, buyer.id, '42.5');
    const empty = await retail();
    expect(Money.of(await balanceOf(merchant.id)).toWire()).toBe('120.5000');
    expect(Money.of(await balanceOf(buyer.id)).toWire()).toBe('42.5000');
    expect(Money.of(await balanceOf(empty.id)).toWire()).toBe('0.0000');
  });

  it('ignores the wallet of the other kind that a rank change left behind', async () => {
    const account = await insertWalletMerchant(db);
    await fundWallet(db, account.id, '40');
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, account.id));
    expect(Money.of(await balanceOf(account.id)).toWire()).toBe('0.0000');
  });
});
