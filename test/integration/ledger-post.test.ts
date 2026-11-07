// Integration tests of postTransaction (decision 024, map money events): the only ledger writer, on real Postgres. Entries and
// balance_after, idempotent replays, the credit-limit guard, the 13 events together, and concurrency (parallel posts on one
// wallet never overspend, one key posts once, opposite postings do not deadlock).
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import {
  LedgerPoster,
  LedgerRefRequiredError,
  type PostTransactionInput,
  adjust,
  b2cChargeback,
  b2cDeliver,
  b2cFee,
  b2cPay,
  b2cRefund,
  commission,
  complete,
  deposit,
  order,
  payout,
  postTransaction,
  reject,
  topup,
} from '../../src/modules/money';
import { findBalanceDifferences } from '../../src/modules/money/infra/ledger-read.repository';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { accountFigures, fundWallet, insertWalletMerchant, ledgerTotals } from '../support/money';
import { TestClock } from '../support/clock';
import { rejectionOf } from '../support/rejection';

beforeEach(resetDb);
afterAll(closeTestDb);

const m = (amount: string) => Money.of(amount);
const SYSTEM = { type: 'system', id: null } as const;
let counter = 0;
/** A posting with a fresh idempotency key. */
const input = (posting: ReturnType<typeof deposit>, refId = 1, key = `t:${++counter}`): PostTransactionInput => ({
  ...posting,
  refId,
  idempotencyKey: key,
  currency: 'USD',
  createdBy: SYSTEM,
});

async function post(posting: PostTransactionInput, now = new Date()) {
  const { db } = await testDb();
  return db.transaction((tx) => postTransaction(tx, posting, now));
}

describe('postTransaction', () => {
  it('writes the header, signed entries with balance_after, the balances and the versions', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    const when = new Date('2026-11-01T10:00:00.000Z');
    const posted = await post(
      {
        ...input(deposit({ clientId: merchant.id, amount: m('100'), fee: m('3') }), 77, 'deposit:payment:77'),
        memo: 'Deposit PAY-77',
      },
      when,
    );
    expect(posted.replayed).toBe(false);

    const [header] = await db.select().from(s.ledgerTransactions);
    expect(header).toMatchObject({
      id: posted.id,
      kind: 'deposit',
      refType: 'payment',
      refId: 77,
      memo: 'Deposit PAY-77',
      idempotencyKey: 'deposit:payment:77',
      createdByType: 'system',
      createdById: null,
    });
    expect(header!.createdAt).toEqual(when);

    const entries = await db
      .select({
        kind: s.ledgerAccounts.kind,
        amount: s.ledgerEntries.amount,
        balanceAfter: s.ledgerEntries.balanceAfter,
        createdAt: s.ledgerEntries.createdAt,
      })
      .from(s.ledgerEntries)
      .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
      .orderBy(s.ledgerEntries.id);
    // Debit positive; balance_after is the account's own sign: the wallet and the fee income are credit-normal.
    expect(entries.map(({ kind, amount, balanceAfter }) => ({ kind, amount, balanceAfter }))).toEqual([
      { kind: 'gateway_clearing', amount: '103.0000', balanceAfter: '103.0000' },
      { kind: 'client_wallet', amount: '-100.0000', balanceAfter: '100.0000' },
      { kind: 'fee_income', amount: '-3.0000', balanceAfter: '3.0000' },
    ]);
    expect(entries.every((entry) => entry.createdAt.getTime() === when.getTime())).toBe(true);

    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '100.0000',
      version: 1,
    });
    expect(await accountFigures(db, 'gateway_clearing')).toMatchObject({ balance: '103.0000', version: 1 });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('opens the system accounts of a fresh database on first use', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await post(input(payout({ amount: m('14.26') }), 0));
    expect(await accountFigures(db, 'bank')).toMatchObject({ balance: '14.2600' });
    expect(await accountFigures(db, 'gateway_clearing')).toMatchObject({ balance: '-14.2600' });
  });

  it('posts a line twice on one account with the running balance in between', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    // Two credits to revenue and two debits to bank in one posting: balance_after chains line by line.
    const lines = [
      { account: { kind: 'bank' as const }, debit: m('3'), credit: Money.zero() },
      { account: { kind: 'bank' as const }, debit: m('4'), credit: Money.zero() },
      { account: { kind: 'revenue' as const }, debit: Money.zero(), credit: m('7') },
    ];
    await post({ ...input(payout({ amount: m('1') }), 0), kind: 'test', lines });
    const rows = await db.select().from(s.ledgerEntries).orderBy(s.ledgerEntries.id);
    expect(rows.map((row) => row.balanceAfter)).toEqual(['3.0000', '7.0000', '7.0000']);
    expect(await accountFigures(db, 'bank')).toMatchObject({ balance: '7.0000', version: 1 });
  });

  it('returns the first transaction for a repeated idempotency key and posts nothing', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchant = await insertWalletMerchant(db);
    const posting = input(deposit({ clientId: merchant.id, amount: m('40') }), 9, 'deposit:payment:9');
    const first = await post(posting);
    const before = await ledgerTotals(db);
    const second = await post(posting);
    expect(second).toEqual({ id: first.id, replayed: true, touched: [] });
    expect(await ledgerTotals(db)).toEqual(before);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '40.0000',
      version: 1,
    });
  });

  it('refuses unbalanced lines with LEDGER_UNBALANCED before writing anything', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const lines = [
      { account: { kind: 'bank' as const }, debit: m('10'), credit: Money.zero() },
      { account: { kind: 'revenue' as const }, debit: Money.zero(), credit: m('9.9999') },
    ];
    const error = await rejectionOf(post({ ...input(payout({ amount: m('1') }), 0), lines }));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('LEDGER_UNBALANCED');
    expect(await ledgerTotals(db)).toEqual({ sum: '0.0000', entries: 0, transactions: 0 });
  });

  it('stores ref_id 0 for a system posting and refuses 0 for any other reference type', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await post(input(payout({ amount: m('5') }), 0));
    const [header] = await db.select().from(s.ledgerTransactions);
    expect(header).toMatchObject({ refType: 'system', refId: 0 });

    const error = await rejectionOf(post(input(topup({ supplierId: 2, amount: m('5') }), 0)));
    expect(error).toBeInstanceOf(LedgerRefRequiredError);
    expect((error as LedgerRefRequiredError).code).toBe('LEDGER_REF_REQUIRED');
    expect(await rejectionOf(post(input(payout({ amount: m('5') }), -1)))).toBeInstanceOf(RangeError);
    expect((await ledgerTotals(db)).transactions).toBe(1);
  });

  it('refuses a system actor with an id and a staff actor without one', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const base = input(payout({ amount: m('5') }), 0);
    expect(await rejectionOf(post({ ...base, createdBy: { type: 'system', id: 3 } }))).toBeInstanceOf(RangeError);
    expect(await rejectionOf(post({ ...base, createdBy: { type: 'staff', id: null } }))).toBeInstanceOf(RangeError);
  });

  it('stamps the header with the time of the injected clock', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const clock = new TestClock('2026-03-01T09:30:00.000Z');
    const poster = new LedgerPoster(clock);
    const read = () =>
      db.select({ at: s.ledgerTransactions.createdAt }).from(s.ledgerTransactions).orderBy(s.ledgerTransactions.id);
    await db.transaction((tx) => poster.post(tx, input(payout({ amount: m('1') }), 0)));
    clock.advance(90_000);
    await db.transaction((tx) => poster.post(tx, input(payout({ amount: m('1') }), 0)));
    expect((await read()).map((row) => row.at.toISOString())).toEqual([
      '2026-03-01T09:30:00.000Z',
      '2026-03-01T09:31:30.000Z',
    ]);
  });
});

describe('the credit limit guard (decision 024 step 4)', () => {
  it('lets a wallet go below zero only down to its credit limit', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '50' });
    await fundWallet(db, merchant.id, '100');
    // 100 + 50 credit = 150 spendable.
    await post(input(adjust({ clientId: merchant.id, amount: m('150'), direction: 'debit' }), merchant.id));
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-50.0000',
    });

    const error = await rejectionOf(
      post(input(adjust({ clientId: merchant.id, amount: m('0.0001'), direction: 'debit' }), merchant.id)),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    expect((error as AppError).detail).toBe('The wallet would end at -50.0001, below its credit limit of 50.0000.');
    // The refused posting left no trace.
    expect((await ledgerTotals(db)).transactions).toBe(2);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-50.0000',
    });
  });

  it('refuses any debit below zero for a wallet without credit', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '10');
    const error = await rejectionOf(post(input(order({ clientId: merchant.id, amount: m('10.0001') }), 5)));
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    await post(input(order({ clientId: merchant.id, amount: m('10') }), 5));
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '0.0000',
    });
    expect(await accountFigures(db, 'client_hold', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '10.0000',
    });
  });

  it('always lets credits through, even while the wallet is below a lowered limit (user rule 2)', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '500' });
    await post(input(adjust({ clientId: merchant.id, amount: m('300'), direction: 'debit' }), merchant.id));
    // The limit is lowered below the credit in use.
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '100.0000' })
      .where(eq(s.ledgerAccounts.ownerId, merchant.id));
    await post(input(adjust({ clientId: merchant.id, amount: m('50'), direction: 'credit' }), merchant.id));
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-250.0000',
    });
    // New debits stay refused until the balance is back above the limit.
    const error = await rejectionOf(post(input(order({ clientId: merchant.id, amount: m('1') }), 1)));
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    await post(input(deposit({ clientId: merchant.id, amount: m('400') }), 2));
    await post(input(order({ clientId: merchant.id, amount: m('1') }), 1));
  });
});

describe('the 13 money events together', () => {
  it('post in sequence, keep the books at zero, and agree with the reconcile comparison', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const agent = await insertWalletMerchant(db, { name: 'Agent' });
    const c = merchant.id;
    const sequence: PostTransactionInput[] = [
      input(deposit({ clientId: c, amount: m('100'), fee: m('3') }), 1),
      input(order({ clientId: c, amount: m('5') }), 11),
      input(complete({ clientId: c, price: m('5'), cost: m('3'), supplierId: 2 }), 11),
      input(order({ clientId: c, amount: m('5') }), 12),
      input(reject({ clientId: c, amount: m('5') }), 12),
      input(topup({ supplierId: 2, amount: m('50') }), 2),
      input(commission({ clientId: agent.id, amount: m('0.20') }), 3),
      input(adjust({ clientId: c, amount: m('10'), direction: 'credit' }), c),
      input(adjust({ clientId: c, amount: m('4'), direction: 'debit' }), c),
      input(b2cPay({ net: m('12.49'), vat: m('2.50') }), 21),
      input(b2cFee({ fee: m('0.73') }), 21),
      input(b2cDeliver({ net: m('12.49'), cost: m('7.20'), supplierId: 2 }), 21),
      input(b2cPay({ net: m('12.49'), vat: m('2.50') }), 22),
      input(b2cRefund({ net: m('12.49'), vat: m('2.50') }), 22),
      input(b2cPay({ net: m('12.49'), vat: m('2.50') }), 23),
      input(b2cDeliver({ net: m('12.49'), cost: m('7.20'), supplierId: 2 }), 23),
      input(b2cChargeback({ amount: m('14.99'), fee: m('15') }), 23),
      input(payout({ amount: m('14.26') }), 0),
    ];
    for (const posting of sequence) await post(posting);

    const totals = await ledgerTotals(db);
    expect(totals.transactions).toBe(sequence.length);
    expect(totals.sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
    // Spot checks against the map's numbers: wallet 100 - 5 (completed) + 10 - 4 = 101; revenue 5 + 12.49 + 12.49 = 29.98.
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: c })).toMatchObject({ balance: '101.0000' });
    expect(await accountFigures(db, 'revenue')).toMatchObject({ balance: '29.9800' });
    expect(await accountFigures(db, 'fee_income')).toMatchObject({ balance: '3.0000' });
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: agent.id })).toMatchObject({
      balance: '0.2000',
    });
    // 50 topup - 3 - 7.20 - 7.20 = 32.60 left at the supplier.
    expect(await accountFigures(db, 'supplier_prepaid', { type: 'supplier', id: 2 })).toMatchObject({
      balance: '32.6000',
    });
  });
});

describe('concurrency', () => {
  it('never lets parallel holds overspend one wallet', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '100');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        post(input(order({ clientId: merchant.id, amount: m('30') }), 100 + index)),
      ),
    );
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(refused).toHaveLength(7);
    expect(refused.every((result) => (result.reason as AppError).code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '10.0000',
    });
    expect(await accountFigures(db, 'client_hold', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '90.0000',
    });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('stops at the credit limit under parallel debits', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { creditLimit: '100' });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        post(input(adjust({ clientId: merchant.id, amount: m('30'), direction: 'debit' }), merchant.id)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '-90.0000',
    });
  });

  it('posts a duplicate idempotency key once, however many arrive together', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    const posting = input(deposit({ clientId: merchant.id, amount: m('25') }), 5, 'deposit:payment:5');
    const results = await Promise.all(Array.from({ length: 8 }, () => post(posting)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await ledgerTotals(db)).toMatchObject({ transactions: 1, entries: 2 });
    expect(await accountFigures(db, 'client_wallet', { type: 'client', id: merchant.id })).toMatchObject({
      balance: '25.0000',
    });
  });

  it('does not deadlock when postings touch the same accounts in opposite directions', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await fundWallet(db, merchant.id, '1000');
    const work: Array<Promise<unknown>> = [];
    for (let index = 0; index < 20; index++) {
      const posting =
        index % 2 === 0
          ? order({ clientId: merchant.id, amount: m('10') })
          : reject({ clientId: merchant.id, amount: m('1') });
      work.push(post(input(posting, 200 + index)));
    }
    const settled = await Promise.allSettled(work);
    // A reject with nothing held yet drives the hold negative, which the ledger allows; what matters is that no posting dies of a deadlock.
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
  });
});
