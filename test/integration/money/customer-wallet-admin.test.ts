// Integration tests of the staff customer wallet routes (feature 21, plan § 7.1 routes 11 to 16): the view, the statement with its window,
// adjust (once per key, key reuse, approval limit, no overdraft, NO_ACCOUNT, ANONYMIZED, audit and mail), freeze and unfreeze, the list
// with its filters, sorts, search and x-total-count, and the permission refusals. Decision 049: the approval limit caps a staff member's
// credits to customer balances over 24 hours; an Owner is not limited.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
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
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { insertCustomer } from '../../support/support';
import { CONSOLE_ORIGIN } from '../../support/staff-console';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
let reader: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['wallet:read', 'wallet:adjust'], { name: 'Rami K.' });
  reader = await adminWith(t, ['customers:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const key = (value: string = crypto.randomUUID()) => ({ 'idempotency-key': value });

async function customer(values: Partial<typeof s.customers.$inferInsert> = {}) {
  const { db } = await testDb();
  return insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera', ...values });
}

async function auditOf(customerId: number) {
  const { db } = await testDb();
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'customer'), eq(s.auditLogs.entityId, customerId)))
    .orderBy(s.auditLogs.id);
}

async function mailsOf(customerId: number, event: string) {
  const { db } = await testDb();
  return db
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.recipientId, customerId), eq(s.notifications.event, event)));
}

describe('GET /admin/customers/:id/wallet', () => {
  it('answers zeros for a customer without a wallet and the figures once funded', async () => {
    const buyer = await customer();
    const empty = await staff.get(`/admin/customers/${buyer.id}/wallet`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      enabled: true,
      currency: 'USD',
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
      frozen: null,
      pendingTopUps: { count: 0, amount: '0.0000' },
      openDisputes: 0,
      adjustApprovalLimit: '500.0000',
    });
    await fundCustomer((await testDb()).db, buyer.id, '42.50');
    expect((await staff.get(`/admin/customers/${buyer.id}/wallet`)).body).toMatchObject({
      balance: '42.5000',
      available: '42.5000',
    });
  });

  it('answers 404 for an unknown customer, 403 without wallet:read and 401 without a session', async () => {
    expect((await staff.get('/admin/customers/999/wallet')).status).toBe(404);
    const buyer = await customer();
    expect((await reader.get(`/admin/customers/${buyer.id}/wallet`)).body.code).toBe('FORBIDDEN');
    expect((await staff.anonymous('GET', `/admin/customers/${buyer.id}/wallet`)).status).toBe(401);
  });

  it('shows available zero while switched off, and the balance', async () => {
    const buyer = await customer();
    const { db } = await testDb();
    await fundCustomer(db, buyer.id, '10');
    await walletSettings(t, db, { 'wallet.customer.enabled': false });
    expect((await staff.get(`/admin/customers/${buyer.id}/wallet`)).body).toMatchObject({
      enabled: false,
      balance: '10.0000',
      available: '0.0000',
    });
  });
});

describe('POST /admin/customers/:id/wallet/adjust', () => {
  it('credits once per key, audits, mails and answers the wallet', async () => {
    const buyer = await customer();
    const body = { amount: '10.0000', direction: 'credit', reason: 'Goodwill for a slow unlock' };
    const headers = key('dialog-1');
    const first = await staff.post(`/admin/customers/${buyer.id}/wallet/adjust`, body, headers);
    expect(first.status).toBe(200);
    expect(first.body.wallet).toMatchObject({ balance: '10.0000', available: '10.0000' });
    const again = await staff.post(`/admin/customers/${buyer.id}/wallet/adjust`, body, headers);
    expect(again.status).toBe(200);
    expect(again.body.transactionId).toBe(first.body.transactionId);
    const { db } = await testDb();
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
    const [journal] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.id, first.body.transactionId));
    expect(journal).toMatchObject({
      kind: 'adjustment',
      refType: 'customer',
      refId: buyer.id,
      idempotencyKey: `adjust:customer:${buyer.id}:dialog-1`,
      createdByType: 'staff',
      createdById: staff.staffId,
      memo: 'Manual credit: Goodwill for a slow unlock',
    });
    const audits = await auditOf(buyer.id);
    expect(audits.map((row) => row.action)).toEqual(['adjusted wallet of', 'repeated wallet adjustment of']);
    expect(audits[0]).toMatchObject({ entityLabel: 'Daniel Rivera', before: { balance: '0.0000' } });
    expect(audits[0]!.after).toMatchObject({ balance: '10.0000', amount: '10.0000', direction: 'credit' });
    const mails = await mailsOf(buyer.id, 'wallet.adjusted');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.payload).toMatchObject({ variables: { change: '+10.00 USD', balance: '10.00 USD' } });
  });

  it('refuses the same key with another body, a missing key, and a debit below zero', async () => {
    const buyer = await customer();
    const url = `/admin/customers/${buyer.id}/wallet/adjust`;
    await staff.post(url, { amount: '10.0000', direction: 'credit', reason: 'First credit here' }, key('K'));
    const reused = await staff.post(
      url,
      { amount: '11.0000', direction: 'credit', reason: 'First credit here' },
      key('K'),
    );
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await staff.post(url, { amount: '1.0000', direction: 'credit', reason: 'No key at all' });
    expect(missing.status).toBe(422);
    const overdraw = await staff.post(url, { amount: '10.0001', direction: 'debit', reason: 'Too much taken' }, key());
    expect(overdraw.status).toBe(402);
    expect(overdraw.body.code).toBe('INSUFFICIENT_FUNDS');
    const exact = await staff.post(url, { amount: '10.0000', direction: 'debit', reason: 'Everything back' }, key());
    expect(exact.body.wallet.balance).toBe('0.0000');
  });

  it('refuses above the approval limit, a credit without an account or to an anonymized customer', async () => {
    const buyer = await customer();
    const above = await staff.post(
      `/admin/customers/${buyer.id}/wallet/adjust`,
      { amount: '500.0001', direction: 'credit', reason: 'Large credit' },
      key(),
    );
    expect(above.body.code).toBe('APPROVAL_REQUIRED');
    const guest = await customer({ hasAccount: false });
    const noAccount = await staff.post(
      `/admin/customers/${guest.id}/wallet/adjust`,
      { amount: '1.0000', direction: 'credit', reason: 'Guest credit' },
      key(),
    );
    expect(noAccount.body.code).toBe('NO_ACCOUNT');
    const gone = await customer({ status: 'anonymized', hasAccount: false });
    const anonymized = await staff.post(
      `/admin/customers/${gone.id}/wallet/adjust`,
      { amount: '1.0000', direction: 'credit', reason: 'Late credit' },
      key(),
    );
    expect(anonymized.body.code).toBe('ANONYMIZED');
    expect((await reader.post(`/admin/customers/${buyer.id}/wallet/adjust`, {}, key())).body.code).toBe('FORBIDDEN');
  });

  it("counts a staff member's credits to customer balances over 24 hours; an owner is not limited (decision 049)", async () => {
    const first = await customer();
    const second = await customer({ name: 'Second buyer' });
    const adjustOf = (api: AdminApi, customerId: number, amount: string) =>
      api.post(
        `/admin/customers/${customerId}/wallet/adjust`,
        { amount, direction: 'credit', reason: 'Goodwill credit' },
        key(),
      );
    expect((await adjustOf(staff, first.id, '300.0000')).status).toBe(200);
    expect((await adjustOf(staff, second.id, '200.0000')).status).toBe(200);
    const refused = await adjustOf(staff, first.id, '0.0001');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'APPROVAL_REQUIRED',
      detail: 'Credits over $500 in 24 hours need an owner: yours would come to $500.0001.',
    });
    const owner = await adminWith(t, ['*']);
    expect((await adjustOf(owner, first.id, '600.0000')).status).toBe(200);
    expect((await adjustOf(owner, first.id, '600.0000')).status).toBe(200);
    // Another staff member's credits are their own.
    const colleague = await adminWith(t, ['wallet:read', 'wallet:adjust']);
    expect((await adjustOf(colleague, second.id, '500.0000')).status).toBe(200);
  });

  it('never overspends under parallel debits of different keys', async () => {
    const buyer = await customer();
    const { db } = await testDb();
    await fundCustomer(db, buyer.id, '100');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        staff.post(
          `/admin/customers/${buyer.id}/wallet/adjust`,
          { amount: '30.0000', direction: 'debit', reason: 'Parallel debit' },
          key(),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(3);
    expect(results.filter((result) => result.status !== 200).every((result) => result.status === 402)).toBe(true);
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '10.0000' });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });
});

describe('POST /admin/customers/:id/wallet/freeze and /unfreeze', () => {
  it('freezes once (a second freeze changes nothing), mails once, and unfreezes', async () => {
    const buyer = await customer();
    const { db } = await testDb();
    await fundCustomer(db, buyer.id, '20');
    const url = `/admin/customers/${buyer.id}/wallet`;
    const frozen = await staff.post(`${url}/freeze`, { reason: 'Checking a payment' }, key());
    expect(frozen.status).toBe(200);
    expect(frozen.body).toMatchObject({
      available: '0.0000',
      frozen: { at: '2026-11-10T09:00:00.000Z', reason: 'Checking a payment' },
    });
    clock.advance(60_000);
    const twice = await staff.post(`${url}/freeze`, { reason: 'Another reason' }, key());
    expect(twice.body.frozen).toEqual({ at: '2026-11-10T09:00:00.000Z', reason: 'Checking a payment' });
    expect(await mailsOf(buyer.id, 'wallet.frozen')).toHaveLength(1);
    const audits = await auditOf(buyer.id);
    expect(audits.map((row) => row.action)).toEqual(['froze wallet of', 'froze wallet of']);
    expect(audits[1]!.after).toMatchObject({ alreadyFrozen: true });
    // Staff can still adjust a frozen wallet.
    expect(
      (await staff.post(`${url}/adjust`, { amount: '5.0000', direction: 'debit', reason: 'Fee while held' }, key()))
        .status,
    ).toBe(200);
    const lifted = await staff.post(`${url}/unfreeze`, { reason: 'All clear now' }, key());
    expect(lifted.body).toMatchObject({ frozen: null, balance: '15.0000', available: '15.0000' });
    expect((await auditOf(buyer.id)).at(-1)!.action).toBe('unfroze wallet of');
  });

  it('freezes a customer who has no wallet yet, and needs the key and a reason', async () => {
    const buyer = await customer();
    const url = `/admin/customers/${buyer.id}/wallet`;
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold' }, key())).status).toBe(422);
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold the wallet' })).status).toBe(422);
    expect((await staff.post(`${url}/freeze`, { reason: 'Hold the wallet' }, key())).body.frozen.reason).toBe(
      'Hold the wallet',
    );
    expect((await staff.post('/admin/customers/999/wallet/freeze', { reason: 'Hold the wallet' }, key())).status).toBe(
      404,
    );
  });

  it('refuses to unfreeze below zero', async () => {
    const buyer = await customer();
    const { db } = await testDb();
    await fundCustomer(db, buyer.id, '10');
    await pushNegative(db, buyer.id, '25');
    const refused = await staff.post(`/admin/customers/${buyer.id}/wallet/unfreeze`, { reason: 'Try to lift' }, key());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFLICT');
    expect(await customerWalletRow(db, buyer.id)).toMatchObject({ balance: '-15.0000', frozenReason: 'Chargeback' });
  });
});

describe('GET /admin/customers/:id/wallet/statement', () => {
  it('lists the lines newest first with the staff reason, filters by window and counts', async () => {
    const buyer = await customer();
    const { db } = await testDb();
    await fundCustomer(db, buyer.id, '30', clock.now());
    clock.advance(10 * 60_000);
    await staff.post(
      `/admin/customers/${buyer.id}/wallet/adjust`,
      { amount: '5.0000', direction: 'debit', reason: 'Internal note here' },
      key(),
    );
    const page = await staff.get(`/admin/customers/${buyer.id}/wallet/statement`);
    expect(page.status).toBe(200);
    expect(page.total).toBe(2);
    expect(page.body[0]).toMatchObject({
      kind: 'adjustment',
      memo: 'Manual debit: Internal note here',
      amount: '-5.0000',
      balanceAfter: '25.0000',
    });
    expect(page.body[1]).toMatchObject({ kind: 'deposit', amount: '30.0000', balanceAfter: '30.0000' });
    const later = await staff.get(
      `/admin/customers/${buyer.id}/wallet/statement?createdAt_gte=2026-11-10T09:05:00.000Z`,
    );
    expect(later.total).toBe(1);
    expect((await staff.get('/admin/customers/999/wallet/statement')).status).toBe(404);
  });
});

describe('GET /admin/customer-wallets and the customer’s address (decision 047)', () => {
  it('masks the wallet list’s address and searches names only without customers:read', async () => {
    const { db } = await testDb();
    const alice = await customer({ name: 'Alice Rich', email: 'alice@mail.example' });
    await fundCustomer(db, alice.id, '80');
    const emails = async (api: AdminApi, query = '') =>
      (await api.get(`/admin/customer-wallets${query}`)).body.map(
        (row: { customer: { email: string } }) => row.customer.email,
      );
    expect(await emails(staff)).toEqual(['al•••@mail.example']);
    const withRead = await adminWith(t, ['wallet:read', 'customers:read']);
    expect(await emails(withRead)).toEqual(['alice@mail.example']);
    expect(await emails(staff, '?q=alice%40mail')).toEqual([]);
    expect(await emails(staff, '?q=alice+r')).toEqual(['al•••@mail.example']);
    expect(await emails(withRead, '?q=alice%40mail')).toEqual(['alice@mail.example']);
  });
});

describe('GET /admin/customer-wallets', () => {
  it('lists every wallet with state filters, sorts, search and x-total-count', async () => {
    const { db } = await testDb();
    const rich = await customer({ name: 'Alice Rich', email: 'alice@mail.example' });
    const zero = await customer({ name: 'Zed Zero', email: 'zed@mail.example' });
    const owing = await customer({ name: 'Olive Owing', email: 'olive@mail.example' });
    await fundCustomer(db, rich.id, '80');
    await fundCustomer(db, zero.id, '5');
    await staff.post(
      `/admin/customers/${zero.id}/wallet/adjust`,
      { amount: '5.0000', direction: 'debit', reason: 'Back to zero' },
      key(),
    );
    await pushNegative(db, owing.id, '12');

    const all = await staff.get('/admin/customer-wallets?_sort=balance&_order=desc');
    expect(all.total).toBe(3);
    expect(all.body.map((row: { customer: { id: number } }) => row.customer.id)).toEqual([rich.id, zero.id, owing.id]);
    expect(all.body[0]).toMatchObject({
      // Decision 047: this caller does not hold customers:read, so the address comes masked.
      customer: { name: 'Alice Rich', email: 'al•••@mail.example', status: 'active' },
      balance: '80.0000',
      frozen: null,
    });
    const negative = await staff.get('/admin/customer-wallets?state=negative');
    expect(negative.body).toHaveLength(1);
    expect(negative.body[0].frozen).toMatchObject({ reason: 'Chargeback' });
    expect((await staff.get('/admin/customer-wallets?state=frozen')).total).toBe(1);
    expect((await staff.get('/admin/customer-wallets?state=zero&state=positive')).total).toBe(2);
    const withRead = await adminWith(t, ['wallet:read', 'customers:read']);
    expect(
      (await withRead.get('/admin/customer-wallets?q=zed%40mail')).body.map(
        (row: { customer: { id: number } }) => row.customer.id,
      ),
    ).toEqual([zero.id]);
    // The name is searched for everybody; the address only for a caller who holds customers:read (decision 047).
    expect((await staff.get('/admin/customer-wallets?q=zed%40mail')).total).toBe(0);
    expect(
      (await staff.get('/admin/customer-wallets?q=Zed+Z')).body.map(
        (row: { customer: { id: number } }) => row.customer.id,
      ),
    ).toEqual([zero.id]);
    expect((await staff.get('/admin/customer-wallets?q=nobody')).total).toBe(0);
    expect((await staff.get('/admin/customer-wallets?state=rich')).status).toBe(422);
    expect((await reader.get('/admin/customer-wallets')).status).toBe(403);
  });
});
