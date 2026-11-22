// Integration tests of the merchant wallet routes (map stage 3, user rule 2): GET /admin/clients/:id/wallet and /statement,
// POST /admin/clients/:id/wallet/adjust and PATCH /admin/clients/:id/credit-limit, through HTTP on the real application. Decision 049: the
// approval limit caps a staff member's credits over 24 hours (a debit alone, an Owner exempt), a credit limit above it needs an Owner.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { schema as s } from '@src/infra/db';
import { adjust, creditLine, debitLine, deposit, order, postTransaction, reopen } from '@src/modules/money';
import { complete } from '@src/modules/money';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant, openSession, signInStaff } from '../../support/auth';
import { DAY, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { accountFigures, fundWallet, insertWalletMerchant, ledgerTotals } from '../../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

const m = (amount: string) => Money.of(amount);
const ZERO_WALLET = { balance: '0.0000', reserved: '0.0000', creditLimit: '0.0000', available: '0.0000' };

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const send = (
  staff: Staff,
  method: 'POST' | 'PATCH',
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({ method, url, headers: { ...staff.session.mutationHeaders, ...headers }, payload: payload as never });

const adjustBody = (overrides: Record<string, unknown> = {}) => ({
  amount: '10.0000',
  direction: 'credit',
  reason: 'Goodwill credit for a failed order',
  ...overrides,
});

describe('GET /admin/clients/:id/wallet', () => {
  it('answers the four figures from the ledger: balance, reserved, credit limit and available', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '2000' });
    await fundWallet(db, merchant.id, '120.5');
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...order({ clientId: merchant.id, amount: m('20') }),
          refId: 5,
          idempotencyKey: 'order:5',
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    const staff = await signInStaff(t, ['wallet:read']);
    const res = await get(staff, `/admin/clients/${merchant.id}/wallet`);
    expect(res.statusCode).toBe(200);
    // balance = wallet (the hold already left it), reserved = hold, available = balance + credit limit.
    expect(res.json()).toEqual({
      balance: '100.5000',
      reserved: '20.0000',
      creditLimit: '2000.0000',
      available: '2100.5000',
    });
  });

  it('shows credit in use as a negative balance', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '500' });
    const staff = await signInStaff(t, ['wallet:read', 'wallet:adjust']);
    await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '200.0000', direction: 'debit' }),
    );
    expect((await get(staff, `/admin/clients/${merchant.id}/wallet`)).json()).toEqual({
      balance: '-200.0000',
      reserved: '0.0000',
      creditLimit: '500.0000',
      available: '300.0000',
    });
  });

  it('answers zeros for a merchant that has no accounts yet, and reads fresh figures every time', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchantId = await insertMerchant(db);
    const staff = await signInStaff(t, ['wallet:read']);
    expect((await get(staff, `/admin/clients/${merchantId}/wallet`)).json()).toEqual(ZERO_WALLET);
    await fundWallet(db, merchantId, '5');
    expect((await get(staff, `/admin/clients/${merchantId}/wallet`)).json().balance).toBe('5.0000');
  });

  it('answers 404 for an unknown merchant, 422 for a bad id, 403 without wallet:read and 401 without a session', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const reader = await signInStaff(t, ['wallet:read']);
    expect((await get(reader, '/admin/clients/9999/wallet')).json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await get(reader, '/admin/clients/abc/wallet')).statusCode).toBe(422);
    const other = await signInStaff(t, ['ledger:read']);
    expect((await get(other, `/admin/clients/${merchant.id}/wallet`)).json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await t.app.inject({ method: 'GET', url: `/admin/clients/${merchant.id}/wallet` })).statusCode).toBe(401);
  });
});

describe('GET /admin/clients/:id/statement', () => {
  async function history() {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const post = (posting: ReturnType<typeof deposit>, refId: number, key: string) => {
      clock.advance(MINUTE);
      return db.transaction((tx) =>
        postTransaction(
          tx,
          {
            ...posting,
            refId,
            idempotencyKey: key,
            currency: 'USD',
            memo: key,
            createdBy: { type: 'system', id: null },
          },
          clock.now(),
        ),
      );
    };
    await post(deposit({ clientId: merchant.id, amount: m('100') }), 1, 'deposit one');
    await post(order({ clientId: merchant.id, amount: m('5') }), 7, 'hold');
    await post(complete({ clientId: merchant.id, price: m('5'), cost: m('3'), supplierId: 2 }), 7, 'settle');
    await post(adjust({ clientId: merchant.id, amount: m('10'), direction: 'credit' }), merchant.id, 'adjust');
    return merchant;
  }

  it('lists the wallet lines from the merchant side, newest first, without the lines that only move the hold', async () => {
    const merchant = await history();
    const staff = await signInStaff(t, ['wallet:read']);
    const res = await get(staff, `/admin/clients/${merchant.id}/statement`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('3');
    const rows = res.json<Array<Record<string, unknown>>>();
    // The settle journal moves client_hold, never the wallet: three lines, not four.
    expect(rows.map((row) => [row.kind, row.amount, row.balanceAfter])).toEqual([
      ['adjustment', '10.0000', '105.0000'],
      ['order_hold', '-5.0000', '95.0000'],
      ['deposit', '100.0000', '100.0000'],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'amount',
      'balanceAfter',
      'createdAt',
      'id',
      'kind',
      'memo',
      'transactionId',
    ]);
    expect(rows[2]).toMatchObject({ memo: 'deposit one', createdAt: '2026-11-01T10:01:00.000Z' });
  });

  it('sorts by createdAt in either direction, pages with the range and counts exactly', async () => {
    const merchant = await history();
    const staff = await signInStaff(t, ['wallet:read']);
    const ascending = await get(staff, `/admin/clients/${merchant.id}/statement?_sort=createdAt&_order=asc`);
    expect(ascending.json<Array<{ kind: string }>>().map((row) => row.kind)).toEqual([
      'deposit',
      'order_hold',
      'adjustment',
    ]);
    const page = await get(staff, `/admin/clients/${merchant.id}/statement?_start=1&_end=2`);
    expect(page.headers['x-total-count']).toBe('3');
    expect(page.json<Array<{ kind: string }>>().map((row) => row.kind)).toEqual(['order_hold']);
  });

  it('breaks equal times by the entry id and links each line to its journal', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const first = await fundWallet(db, merchant.id, '1', 'a');
    const second = await fundWallet(db, merchant.id, '2', 'b');
    const staff = await signInStaff(t, ['wallet:read', 'ledger:read']);
    const rows = (await get(staff, `/admin/clients/${merchant.id}/statement`)).json<Array<{ transactionId: number }>>();
    // Both journals were stamped by the same Date.now() millisecond or close: the later entry id comes first when newest-first.
    expect(rows.map((row) => row.transactionId)).toEqual([second, first]);
    const journal = await get(staff, `/admin/ledger/transactions/${rows[0]!.transactionId}`);
    expect(journal.statusCode).toBe(200);
  });

  it('is empty for a merchant without accounts, 404 for an unknown one, and refuses a sort it does not offer', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchantId = await insertMerchant(db);
    const staff = await signInStaff(t, ['wallet:read']);
    const empty = await get(staff, `/admin/clients/${merchantId}/statement`);
    expect(empty.json()).toEqual([]);
    expect(empty.headers['x-total-count']).toBe('0');
    expect((await get(staff, '/admin/clients/9999/statement')).json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await get(staff, `/admin/clients/${merchantId}/statement?_sort=amount`)).statusCode).toBe(422);
    expect((await get(staff, `/admin/clients/${merchantId}/statement?kind=deposit`)).statusCode).toBe(422);
  });
});

describe('POST /admin/clients/:id/wallet/adjust', () => {
  it('credits the wallet: one balanced journal, the staff member as author, the reason in the memo, an audit row', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const staff = await signInStaff(t, ['wallet:adjust']);
    const res = await send(staff, 'POST', `/admin/clients/${merchant.id}/wallet/adjust`, adjustBody());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ transactionId: number; wallet: Record<string, string> }>();
    expect(body.wallet).toEqual({
      balance: '10.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '10.0000',
    });

    const [header] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.id, body.transactionId));
    expect(header).toMatchObject({
      kind: 'adjustment',
      memo: 'Manual credit: Goodwill credit for a failed order',
      refType: 'client',
      refId: merchant.id,
      createdByType: 'staff',
      createdById: staff.staffId,
    });
    expect(header!.createdAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    const lines = await db
      .select({ kind: s.ledgerAccounts.kind, amount: s.ledgerEntries.amount })
      .from(s.ledgerEntries)
      .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
      .where(eq(s.ledgerEntries.transactionId, body.transactionId))
      .orderBy(s.ledgerEntries.id);
    expect(lines).toEqual([
      { kind: 'adjustments', amount: '10.0000' },
      { kind: 'client_wallet', amount: '-10.0000' },
    ]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');

    const audits = await db.select().from(s.auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'staff',
      actorId: staff.staffId,
      action: 'adjusted wallet of',
      entityType: 'merchant',
      entityId: merchant.id,
      entityLabel: 'Zain Mobile Hub',
      before: { balance: '0.0000' },
      after: { balance: '10.0000', transactionId: body.transactionId, amount: '10.0000', direction: 'credit' },
    });
  });

  it('debits the wallet as the exact mirror', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '50');
    const staff = await signInStaff(t, ['wallet:adjust']);
    const res = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '12.5000', direction: 'debit' }),
    );
    expect(res.json().wallet.balance).toBe('37.5000');
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({ action: 'adjusted wallet of', after: { direction: 'debit' } });
    expect(await accountFigures(db, 'adjustments')).toMatchObject({ balance: '-12.5000' });
  });

  it('refuses a debit below the credit limit with 409 CREDIT_LIMIT_EXCEEDED, posting and auditing nothing', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    const staff = await signInStaff(t, ['wallet:adjust']);
    const res = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '100.0001', direction: 'debit' }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'CREDIT_LIMIT_EXCEEDED',
      detail: expect.stringContaining('credit limit of 100.0000'),
    });
    expect(await ledgerTotals(db)).toMatchObject({ transactions: 0 });
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    // Exactly the limit is fine.
    const ok = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '100.0000', direction: 'debit' }),
    );
    expect(ok.json().wallet).toMatchObject({ balance: '-100.0000', available: '0.0000' });
  });

  it('asks an owner above the limit, with $10,000 as the default', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const staff = await signInStaff(t, ['wallet:adjust']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    const refused = await send(staff, 'POST', url, adjustBody({ amount: '10000.0001' }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'APPROVAL_REQUIRED',
      detail: 'Credits over $10,000 in 24 hours need an owner: yours would come to $10,000.0001.',
    });
    expect((await send(staff, 'POST', url, adjustBody({ amount: '10000.0000' }))).statusCode).toBe(200);
  });

  describe("a staff member's credits over 24 hours (decision 049)", () => {
    const credit = (staff: Staff, clientId: number, amount: string, key?: string) =>
      send(
        staff,
        'POST',
        `/admin/clients/${clientId}/wallet/adjust`,
        adjustBody({ amount }),
        key === undefined ? {} : { 'idempotency-key': key },
      );
    const debit = (staff: Staff, clientId: number, amount: string) =>
      send(staff, 'POST', `/admin/clients/${clientId}/wallet/adjust`, adjustBody({ amount, direction: 'debit' }));

    it('counts them together per staff member, judges a debit alone, and forgets them after a day', async () => {
      const { db } = await testDb();
      const x = await insertWalletMerchant(db, { name: 'X' });
      const y = await insertWalletMerchant(db, { name: 'Y' });
      const z = await insertWalletMerchant(db, { name: 'Z', creditLimit: '20000' });
      const a = await signInStaff(t, ['wallet:adjust']);
      const b = await signInStaff(t, ['wallet:adjust']);
      expect((await credit(a, x.id, '6000.0000')).statusCode).toBe(200);
      expect((await credit(a, y.id, '4000.0000')).statusCode).toBe(200);
      const third = await credit(a, x.id, '0.0001');
      expect(third.statusCode).toBe(409);
      expect(third.json()).toMatchObject({
        code: 'APPROVAL_REQUIRED',
        detail: 'Credits over $10,000 in 24 hours need an owner: yours would come to $10,000.0001.',
      });
      // Debits are not summed and do not lower the sum.
      expect((await debit(a, z.id, '9000.0000')).statusCode).toBe(200);
      expect((await credit(a, y.id, '0.0001')).json()).toMatchObject({
        code: 'APPROVAL_REQUIRED',
        detail: expect.stringContaining('$10,000.00'),
      });
      const big = await debit(a, z.id, '10000.0001');
      expect(big.statusCode).toBe(409);
      expect(big.json()).toMatchObject({ code: 'APPROVAL_REQUIRED', detail: 'Debits over $10,000 need an owner.' });
      // Another staff member has a sum of their own.
      expect((await credit(b, x.id, '5000.0000')).statusCode).toBe(200);
      clock.advance(DAY + 1);
      // A new session of the same staff member (the first one has timed out by now).
      const later = { ...a, session: await openSession(t, { type: 'staff', id: a.staffId }) };
      expect((await credit(later, x.id, '0.0001')).statusCode).toBe(200);
      expect(await accountFigures(db, 'client_wallet', { type: 'client', id: x.id })).toMatchObject({
        balance: '11000.0001',
      });
    });

    it('does not limit an owner', async () => {
      const { db } = await testDb();
      const x = await insertWalletMerchant(db, { creditLimit: '20000' });
      const owner = await signInStaff(t, ['*']);
      expect((await credit(owner, x.id, '15000.0000')).statusCode).toBe(200);
      expect((await credit(owner, x.id, '15000.0000')).statusCode).toBe(200);
      expect((await debit(owner, x.id, '15000.0000')).statusCode).toBe(200);
    });

    it('answers a retry of an accepted adjustment instead of refusing it by the sum', async () => {
      const { db } = await testDb();
      const x = await insertWalletMerchant(db);
      const a = await signInStaff(t, ['wallet:adjust']);
      const first = await credit(a, x.id, '10000.0000', 'k-1');
      expect(first.statusCode).toBe(200);
      const retry = await credit(a, x.id, '10000.0000', 'k-1');
      expect(retry.statusCode).toBe(200);
      expect(retry.json().transactionId).toBe(first.json().transactionId);
      expect((await ledgerTotals(db)).transactions).toBe(1);
      expect((await credit(a, x.id, '1.0000', 'k-2')).statusCode).toBe(409);
    });

    it('judges two credits of one staff member at once one after the other', async () => {
      const { db } = await testDb();
      const x = await insertWalletMerchant(db);
      const a = await signInStaff(t, ['wallet:adjust']);
      const answers = await Promise.all([credit(a, x.id, '6000.0000', 'p-1'), credit(a, x.id, '6000.0000', 'p-2')]);
      expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      expect(await accountFigures(db, 'client_wallet', { type: 'client', id: x.id })).toMatchObject({
        balance: '6000.0000',
      });
    });

    it('never counts an order reversal the staff member posted', async () => {
      const { db } = await testDb();
      const x = await insertWalletMerchant(db);
      const a = await signInStaff(t, ['wallet:adjust']);
      expect((await credit(a, x.id, '9000.0000')).statusCode).toBe(200);
      // A reopen (kind adjustment, about an order) and an order reversal that credits the wallet, both in the staff member's name.
      await db.transaction(async (tx) => {
        await postTransaction(
          tx,
          {
            ...reopen({ clientId: x.id, amount: m('5000') }),
            refId: 77,
            idempotencyKey: 'reopen:77',
            currency: 'USD',
            createdBy: { type: 'staff', id: a.staffId },
          },
          clock.now(),
        );
        await postTransaction(
          tx,
          {
            kind: 'adjustment',
            refType: 'order',
            lines: [
              ...debitLine({ kind: 'revenue' }, m('5000')),
              ...creditLine({ kind: 'client_wallet', ownerType: 'client', ownerId: x.id }, m('5000')),
            ],
            refId: 78,
            idempotencyKey: 'reversal:78',
            currency: 'USD',
            createdBy: { type: 'staff', id: a.staffId },
          },
          clock.now(),
        );
      });
      expect((await credit(a, x.id, '1000.0000')).statusCode).toBe(200);
      expect((await credit(a, x.id, '0.0001')).statusCode).toBe(409);
    });
  });

  it('reads the approval limit from the setting wallet.adjust_approval_limit', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    // The jsonb column stores the text 250.5000 as the JSON number 250.5, which is how an admin would write it too.
    await db.insert(s.settings).values({ key: 'wallet.adjust_approval_limit', value: '250.5000' });
    await clearIdentityCaches(t);
    const staff = await signInStaff(t, ['wallet:adjust']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    const refused = await send(staff, 'POST', url, adjustBody({ amount: '250.5001' }));
    expect(refused.json()).toMatchObject({ code: 'APPROVAL_REQUIRED', detail: expect.stringContaining('$250.50') });
    expect((await send(staff, 'POST', url, adjustBody({ amount: '250.5000' }))).statusCode).toBe(200);
  });

  it('validates the body field by field with 422', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const staff = await signInStaff(t, ['wallet:adjust']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    const fields = async (body: Record<string, unknown>) => {
      const res = await send(staff, 'POST', url, body);
      expect(res.statusCode).toBe(422);
      return (res.json().errors as Array<{ field: string }>).map((error) => error.field);
    };
    expect(await fields(adjustBody({ amount: '0.0000' }))).toEqual(['amount']);
    expect(await fields(adjustBody({ amount: '-5.0000' }))).toEqual(['amount']);
    expect(await fields(adjustBody({ amount: '10' }))).toEqual(['amount']);
    expect(await fields(adjustBody({ amount: '100000000000000.0000' }))).toEqual(['amount']);
    expect(await fields(adjustBody({ direction: 'sideways' }))).toEqual(['direction']);
    expect(await fields(adjustBody({ reason: 'oops' }))).toEqual(['reason']);
    expect(await fields(adjustBody({ reason: '    ab    ' }))).toEqual(['reason']);
    expect(await fields(adjustBody({ reason: 'x'.repeat(141) }))).toEqual(['reason']);
    expect(await fields({ amount: '0.0000', direction: 'x', reason: '' })).toEqual(['amount', 'direction', 'reason']);
    expect(await ledgerTotals(db)).toMatchObject({ transactions: 0 });
  });

  it('answers 404 for an unknown merchant, 403 without wallet:adjust and 403 CSRF_FAILED without the token', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const staff = await signInStaff(t, ['wallet:adjust']);
    expect((await send(staff, 'POST', '/admin/clients/9999/wallet/adjust', adjustBody())).json()).toMatchObject({
      code: 'NOT_FOUND',
    });
    const reader = await signInStaff(t, ['wallet:read']);
    expect(
      (await send(reader, 'POST', `/admin/clients/${merchant.id}/wallet/adjust`, adjustBody())).json(),
    ).toMatchObject({
      code: 'FORBIDDEN',
    });
    const noToken = await t.app.inject({
      method: 'POST',
      url: `/admin/clients/${merchant.id}/wallet/adjust`,
      headers: staff.session.headers,
      payload: adjustBody() as never,
    });
    expect(noToken.json()).toMatchObject({ code: 'CSRF_FAILED' });
    expect(await ledgerTotals(db)).toMatchObject({ transactions: 0 });
  });

  it('works for a suspended or pending merchant', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, merchant.id));
    const staff = await signInStaff(t, ['wallet:adjust']);
    expect((await send(staff, 'POST', `/admin/clients/${merchant.id}/wallet/adjust`, adjustBody())).statusCode).toBe(
      200,
    );
  });

  it('opens the accounts of a merchant that has none, as the safety fallback', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchantId = await insertMerchant(db);
    const staff = await signInStaff(t, ['wallet:adjust']);
    const res = await send(staff, 'POST', `/admin/clients/${merchantId}/wallet/adjust`, adjustBody());
    expect(res.statusCode).toBe(200);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchantId })).toMatchObject({
      balance: '10.0000',
    });
    expect(await accountFigures(db, 'client_hold', { type: 'client', id: merchantId })).toMatchObject({
      balance: '0.0000',
    });
  });

  describe('with an Idempotency-Key', () => {
    it('posts a retry once and answers the first journal again', async () => {
      const { db } = await testDb();
      const merchant = await insertWalletMerchant(db);
      const staff = await signInStaff(t, ['wallet:adjust']);
      const url = `/admin/clients/${merchant.id}/wallet/adjust`;
      const first = await send(staff, 'POST', url, adjustBody(), { 'idempotency-key': 'retry-1' });
      const again = await send(staff, 'POST', url, adjustBody(), { 'idempotency-key': 'retry-1' });
      expect(again.statusCode).toBe(200);
      expect(again.json().transactionId).toBe(first.json().transactionId);
      expect(again.json().wallet.balance).toBe('10.0000');
      expect((await ledgerTotals(db)).transactions).toBe(1);
      expect((await db.select().from(s.auditLogs)).map((row) => row.action)).toEqual([
        'adjusted wallet of',
        'repeated wallet adjustment of',
      ]);
    });

    it('refuses the same key for a different adjustment with 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const { db } = await testDb();
      const merchant = await insertWalletMerchant(db);
      const staff = await signInStaff(t, ['wallet:adjust']);
      const url = `/admin/clients/${merchant.id}/wallet/adjust`;
      await send(staff, 'POST', url, adjustBody(), { 'idempotency-key': 'k' });
      for (const other of [{ amount: '11.0000' }, { direction: 'debit' }, { reason: 'A different reason' }]) {
        const res = await send(staff, 'POST', url, adjustBody(other), { 'idempotency-key': 'k' });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect((await ledgerTotals(db)).transactions).toBe(1);
    });

    it('lets two merchants use the same key', async () => {
      const { db } = await testDb();
      const one = await insertWalletMerchant(db);
      const two = await insertWalletMerchant(db);
      const staff = await signInStaff(t, ['wallet:adjust']);
      for (const merchant of [one, two]) {
        const res = await send(staff, 'POST', `/admin/clients/${merchant.id}/wallet/adjust`, adjustBody(), {
          'idempotency-key': 'same',
        });
        expect(res.json().wallet.balance).toBe('10.0000');
      }
    });
  });

  it('posts every request when no key is sent', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const staff = await signInStaff(t, ['wallet:adjust']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    await send(staff, 'POST', url, adjustBody());
    await send(staff, 'POST', url, adjustBody());
    expect((await ledgerTotals(db)).transactions).toBe(2);
  });

  it('never overdraws the credit limit under parallel debits', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    const staff = await signInStaff(t, ['wallet:adjust']);
    const url = `/admin/clients/${merchant.id}/wallet/adjust`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => send(staff, 'POST', url, adjustBody({ amount: '30.0000', direction: 'debit' }))),
    );
    expect(results.filter((res) => res.statusCode === 200)).toHaveLength(3);
    expect(
      results.filter((res) => res.statusCode === 409).every((res) => res.json().code === 'CREDIT_LIMIT_EXCEEDED'),
    ).toBe(true);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-90.0000',
    });
  });
});

describe('PATCH /admin/clients/:id/credit-limit (user rule 2)', () => {
  it('sets the limit on a group that allows credit, answers the wallet and audits before and after', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Al-Noor', overdraftAllowed: true });
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    const res = await send(staff, 'PATCH', `/admin/clients/${merchant.id}/credit-limit`, { creditLimit: '2000.0000' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '2000.0000',
      available: '2000.0000',
    });
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      overdraftLimit: '2000.0000',
      version: 1,
    });
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'changed credit limit of',
      entityType: 'merchant',
      entityId: merchant.id,
      entityLabel: 'Al-Noor',
      before: { creditLimit: '0.0000' },
      after: { creditLimit: '2000.0000' },
    });
    expect((await ledgerTotals(db)).transactions).toBe(0);
  });

  it('refuses a limit above zero on a group without overdraft with the one message of rule 2', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: false });
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    const res = await send(staff, 'PATCH', `/admin/clients/${merchant.id}/credit-limit`, { creditLimit: '0.0001' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'creditLimit', message: 'This group does not allow credit.' }],
    });
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      overdraftLimit: '0.0000',
    });
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });

  it('refuses a negative or malformed limit on creditLimit, and removes credit with 0.0000 on any group', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '300', overdraftAllowed: true });
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    const url = `/admin/clients/${merchant.id}/credit-limit`;
    for (const bad of ['-1.0000', '5', 'abc', '']) {
      const res = await send(staff, 'PATCH', url, { creditLimit: bad });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors[0].field).toBe('creditLimit');
    }
    await db.update(s.clientGroups).set({ overdraftAllowed: false });
    const removed = await send(staff, 'PATCH', url, { creditLimit: '0.0000' });
    expect(removed.json().creditLimit).toBe('0.0000');
  });

  it('lets staff lower the limit below the credit in use; new debits are refused until a top-up', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '500', overdraftAllowed: true });
    const staff = await signInStaff(t, ['wallet:credit_limit', 'wallet:adjust', 'wallet:read']);
    await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '300.0000', direction: 'debit' }),
    );

    const lowered = await send(staff, 'PATCH', `/admin/clients/${merchant.id}/credit-limit`, {
      creditLimit: '100.0000',
    });
    expect(lowered.statusCode).toBe(200);
    // 300 owed against a 100 limit: available is negative.
    expect(lowered.json()).toEqual({
      balance: '-300.0000',
      reserved: '0.0000',
      creditLimit: '100.0000',
      available: '-200.0000',
    });

    const refused = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '1.0000', direction: 'debit' }),
    );
    expect(refused.json().code).toBe('CREDIT_LIMIT_EXCEEDED');
    const topup = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '250.0000' }),
    );
    expect(topup.json().wallet.balance).toBe('-50.0000');
    const after = await send(
      staff,
      'POST',
      `/admin/clients/${merchant.id}/wallet/adjust`,
      adjustBody({ amount: '10.0000', direction: 'debit' }),
    );
    expect(after.statusCode).toBe(200);
  });

  it('opens the accounts of a merchant that has none and sets the limit', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const [group] = await db
      .insert(s.clientGroups)
      .values({ name: 'Credit', overdraftAllowed: true })
      .returning({ id: s.clientGroups.id });
    const merchantId = await insertMerchant(db, { groupId: group!.id });
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    const res = await send(staff, 'PATCH', `/admin/clients/${merchantId}/credit-limit`, { creditLimit: '75.0000' });
    expect(res.json().creditLimit).toBe('75.0000');
    expect(await accountFigures(db, 'client_hold', { type: 'client', id: merchantId })).toBeDefined();
  });

  it('needs an owner to raise a limit above the approval limit; lowering does not (decision 049)', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    const owner = await signInStaff(t, ['*']);
    const url = `/admin/clients/${merchant.id}/credit-limit`;
    const refused = await send(staff, 'PATCH', url, { creditLimit: '10000.0001' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'Only an owner can set a credit limit above $10,000.',
    });
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      overdraftLimit: '0.0000',
    });
    expect((await send(staff, 'PATCH', url, { creditLimit: '10000.0000' })).statusCode).toBe(200);
    expect((await send(owner, 'PATCH', url, { creditLimit: '20000.0000' })).statusCode).toBe(200);
    expect((await send(staff, 'PATCH', url, { creditLimit: '15000.0000' })).statusCode).toBe(200);
    expect((await send(staff, 'PATCH', url, { creditLimit: '15000.0000' })).statusCode).toBe(200);
    expect((await send(staff, 'PATCH', url, { creditLimit: '16000.0000' })).statusCode).toBe(403);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      overdraftLimit: '15000.0000',
    });
  });

  it('answers 422, not 500, for an amount the column cannot hold or below zero (decision 049)', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { overdraftAllowed: true });
    const owner = await signInStaff(t, ['*']);
    for (const creditLimit of ['100000000000000.0000', '-1.0000']) {
      const res = await send(owner, 'PATCH', `/admin/clients/${merchant.id}/credit-limit`, { creditLimit });
      expect(res.statusCode, creditLimit).toBe(422);
      expect(res.json().errors[0].field, creditLimit).toBe('creditLimit');
    }
  });

  it('answers 404 for an unknown merchant and 403 without wallet:credit_limit', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const staff = await signInStaff(t, ['wallet:credit_limit']);
    expect(
      (await send(staff, 'PATCH', '/admin/clients/9999/credit-limit', { creditLimit: '0.0000' })).json().code,
    ).toBe('NOT_FOUND');
    const other = await signInStaff(t, ['wallet:adjust']);
    expect(
      (await send(other, 'PATCH', `/admin/clients/${merchant.id}/credit-limit`, { creditLimit: '0.0000' })).json().code,
    ).toBe('FORBIDDEN');
  });
});
