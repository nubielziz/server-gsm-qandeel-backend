// Integration tests of postTransaction with customer wallets (feature 21, plan § 5.5 and § 11.2): credit and debit, the zero floor, the
// clawback override that needs a freeze to commit, parallel debits never overspend, a duplicate key posts once, opposite postings do not
// deadlock, merchant and customer adjust keys never collide, and the reconcile sees no difference.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import {
  type PostTransactionInput,
  b2cWalletPay,
  b2cWalletRefund,
  customerAdjust,
  customerTopup,
  postTransaction,
  topupChargeback,
} from '../../src/modules/money';
import { findBalanceDifferences } from '../../src/modules/money/infra/ledger-read.repository';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { insertWalletMerchant, ledgerTotals } from '../support/money';
import { insertCustomer } from '../support/support';

beforeEach(resetDb);
afterAll(closeTestDb);

const m = (amount: string) => Money.of(amount);
const SYSTEM = { type: 'system', id: null } as const;
let counter = 0;
const input = (
  posting: Pick<PostTransactionInput, 'kind' | 'refType' | 'lines'>,
  refId = 1,
  key = `cw:${++counter}`,
  extra: Partial<PostTransactionInput> = {},
): PostTransactionInput => ({ ...posting, refId, idempotencyKey: key, currency: 'USD', createdBy: SYSTEM, ...extra });

async function post(posting: PostTransactionInput) {
  const { db } = await testDb();
  return db.transaction((tx) => postTransaction(tx, posting, new Date()));
}

async function walletOf(customerId: number) {
  const { db } = await testDb();
  const [row] = await db
    .select()
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.kind, 'customer_wallet'), eq(s.ledgerAccounts.ownerId, customerId)));
  return row;
}

async function customerWithBalance(amount: string) {
  const { db } = await testDb();
  await insertUsd(db);
  const customer = await insertCustomer(db, { hasAccount: true });
  if (amount !== '0') {
    await post(input(customerTopup({ customerId: customer.id, amount: m(amount), from: 'bank' }), 1));
  }
  return customer;
}

describe('postTransaction on a customer wallet', () => {
  it('opens the wallet on the first credit and debits it down to zero', async () => {
    const customer = await customerWithBalance('50');
    const credited = await post(
      input(customerTopup({ customerId: customer.id, amount: m('10'), fee: m('1'), from: 'bank' }), 2),
    );
    const wallet = credited.touched.find((account) => account.kind === 'customer_wallet');
    expect(wallet).toMatchObject({
      ownerType: 'customer',
      ownerId: customer.id,
      before: '50.0000',
      after: '60.0000',
      frozen: false,
    });
    await post(input(b2cWalletPay({ customerId: customer.id, net: m('50'), vat: m('10') }), 3));
    expect(await walletOf(customer.id)).toMatchObject({ balance: '0.0000', currency: 'USD', overdraftLimit: '0.0000' });
    const { db } = await testDb();
    expect(await findBalanceDifferences(db)).toEqual([]);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('refuses a debit below zero with INSUFFICIENT_FUNDS and writes nothing', async () => {
    const customer = await customerWithBalance('20');
    const error = await post(input(b2cWalletPay({ customerId: customer.id, net: m('20'), vat: m('0.01') }), 3)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
    expect((error as AppError).detail).toBe('The balance would end at -0.0100; a store balance cannot go below zero.');
    expect(await walletOf(customer.id)).toMatchObject({ balance: '20.0000' });
    const { db } = await testDb();
    expect(await ledgerTotals(db)).toMatchObject({ transactions: 1 });
  });

  it('lets a refund credit a wallet back after a payment', async () => {
    const customer = await customerWithBalance('30');
    await post(input(b2cWalletPay({ customerId: customer.id, net: m('20'), vat: m('5') }), 4));
    await post(input(b2cWalletRefund({ customerId: customer.id, net: m('20'), vat: m('5') }), 4));
    expect(await walletOf(customer.id)).toMatchObject({ balance: '30.0000' });
  });

  it('reports the frozen state read under the lock', async () => {
    const customer = await customerWithBalance('30');
    const { db } = await testDb();
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: new Date(), frozenReason: 'Staff hold' })
      .where(eq(s.ledgerAccounts.ownerId, customer.id));
    const posted = await post(
      input(customerAdjust({ customerId: customer.id, amount: m('5'), direction: 'debit' }), customer.id),
    );
    expect(posted.touched.find((account) => account.kind === 'customer_wallet')).toMatchObject({
      frozen: true,
      after: '25.0000',
    });
  });
});

describe('the clawback override and the deferred freeze trigger', () => {
  const clawback = (customerId: number, key: string) =>
    input(
      topupChargeback({
        owner: { type: 'customer', id: customerId },
        net: m('48.50'),
        fee: m('1.50'),
        disputeFee: m('15'),
      }),
      9,
      key,
      { allowNegativeCustomerWallet: true },
    );

  it('refuses at commit a wallet left below zero and not frozen', async () => {
    const customer = await customerWithBalance('10');
    const failure = await pgErrorOf(post(clawback(customer.id, 'dispute:9:chargeback')));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('ledger_accounts_negative_customer_wallet_frozen');
    expect(await walletOf(customer.id)).toMatchObject({ balance: '10.0000', frozenAt: null });
  });

  it('commits when the same transaction freezes the wallet after the posting', async () => {
    const customer = await customerWithBalance('10');
    const { db } = await testDb();
    await db.transaction(async (tx) => {
      const posted = await postTransaction(tx, clawback(customer.id, 'dispute:9:chargeback'), new Date());
      const wallet = posted.touched.find((account) => account.kind === 'customer_wallet')!;
      await tx
        .update(s.ledgerAccounts)
        .set({ frozenAt: new Date(), frozenReason: 'Dispute DP-9' })
        .where(eq(s.ledgerAccounts.id, wallet.accountId));
    });
    expect(await walletOf(customer.id)).toMatchObject({ balance: '-38.5000', frozenReason: 'Dispute DP-9' });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('refuses an unfreeze while the wallet is below zero', async () => {
    const customer = await customerWithBalance('10');
    const { db } = await testDb();
    await db.transaction(async (tx) => {
      await postTransaction(tx, clawback(customer.id, 'dispute:9:chargeback'), new Date());
      await tx.update(s.ledgerAccounts).set({ frozenAt: new Date() }).where(eq(s.ledgerAccounts.ownerId, customer.id));
    });
    const failure = await pgErrorOf(
      db.update(s.ledgerAccounts).set({ frozenAt: null }).where(eq(s.ledgerAccounts.ownerId, customer.id)),
    );
    expect(failure.constraint).toBe('ledger_accounts_negative_customer_wallet_frozen');
  });

  it('never lets the merchant override take a customer wallet below zero', async () => {
    const customer = await customerWithBalance('10');
    const error = await post(
      input(customerAdjust({ customerId: customer.id, amount: m('11'), direction: 'debit' }), customer.id, 'k', {
        allowBelowCreditLimit: true,
      }),
    ).catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('concurrency on a customer wallet', () => {
  it('never lets parallel balance payments overspend', async () => {
    const customer = await customerWithBalance('100');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        post(input(b2cWalletPay({ customerId: customer.id, net: m('25'), vat: m('5') }), 100 + index)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(refused.every((result) => (result.reason as AppError).code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await walletOf(customer.id)).toMatchObject({ balance: '10.0000' });
    const { db } = await testDb();
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('posts a duplicate top-up key once, however many arrive together', async () => {
    const customer = await customerWithBalance('0');
    const posting = input(
      customerTopup({ customerId: customer.id, amount: m('25'), from: 'bank' }),
      5,
      'deposit:payment:5',
    );
    const results = await Promise.all(Array.from({ length: 8 }, () => post(posting)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await walletOf(customer.id)).toMatchObject({ balance: '25.0000' });
  });

  it('does not deadlock when credits and debits of one wallet race', async () => {
    const customer = await customerWithBalance('1000');
    const work = Array.from({ length: 20 }, (_, index) =>
      post(
        input(
          index % 2 === 0
            ? b2cWalletPay({ customerId: customer.id, net: m('10'), vat: m('0') })
            : customerTopup({ customerId: customer.id, amount: m('3'), fee: m('1'), from: 'gateway_clearing' }),
          300 + index,
        ),
      ),
    );
    const settled = await Promise.allSettled(work);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await walletOf(customer.id)).toMatchObject({ balance: '930.0000' });
    const { db } = await testDb();
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('keeps merchant and customer adjust keys apart for the same id', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const merchant = await insertWalletMerchant(db);
    const customer = await insertCustomer(db, { hasAccount: true });
    // Both ids are 1 in a fresh database; the keys of the two routes still differ.
    expect(merchant.id).toBe(customer.id);
    await post(
      input(
        customerAdjust({ customerId: customer.id, amount: m('5'), direction: 'credit' }),
        customer.id,
        `adjust:customer:${customer.id}:K`,
      ),
    );
    const second = await post(
      input(
        customerAdjust({ customerId: customer.id, amount: m('5'), direction: 'credit' }),
        customer.id,
        `adjust:${merchant.id}:K`,
      ),
    );
    expect(second.replayed).toBe(false);
    const [count] = await db
      .execute<{ n: number }>(sql`select count(*)::int as n from ledger_transactions where ref_type = 'customer'`)
      .then((r) => r.rows);
    expect(count!.n).toBe(2);
  });
});
