// Integration tests of the reconcile and the nightly integrity check with store balances in the books (feature 21, plan § 5.6.9 and D3;
// the wallet is the `customer_wallet` of a retail-rank account, decision 064): every wallet posting (top-up, balance payment, refund to the
// balance, adjustment, a top-up clawback below zero) reconciles and passes the five checks, `wallets_follow_rank` included (the store balance of
// a retail rank is its live wallet); a balance payment (no gateway) without its journal is found and named `Store balance`; a store balance that
// differs from its lines is labelled with the account.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { HealthJobsModule, LedgerIntegrityProcessor } from '@src/modules/health';
import {
  b2cWalletPay,
  b2cWalletRefund,
  customerAdjust,
  customerTopup,
  postTransaction,
  topupChargeback,
} from '@src/modules/money';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { customerWalletRow } from '../../support/customer-wallet';
import { insertAnyService, insertCustomerOrder } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { ledgerTotals } from '../../support/money';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { insertCustomer } from '../../support/support';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [HealthJobsModule] });
});
beforeEach(async () => {
  clock.set('2026-11-10T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const runJob = () => t.app.get(LedgerIntegrityProcessor, { strict: false }).process({ data: {} } as Job);
const report = async () => (await (await adminWith(t, ['system:read'])).get('/admin/system/integrity')).body;
const checkOf = (body: { checks: Array<{ key: string }> }, key: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
  body.checks.find((check) => check.key === key) as any;

/** Posts one wallet event through the real writer, as the system. */
function post(
  posting: { kind: string; refType: string; lines: unknown },
  refId: number,
  key: string,
  flags: { allowNegativeCustomerWallet?: boolean } = {},
) {
  return db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...(posting as Parameters<typeof postTransaction>[1]),
        refId,
        idempotencyKey: key,
        currency: 'USD',
        createdBy: { type: 'system', id: null },
        ...flags,
      },
      clock.now(),
    ),
  );
}

/** A balance payment row of an order (no gateway), as `CustomerWalletPayments.record` writes it. */
async function balancePayment(orderId: number, accountId: number) {
  const [row] = await db
    .insert(s.payments)
    .values({
      purpose: 'order',
      methodType: 'balance',
      gatewayId: null,
      accountId,
      orderId,
      amount: '4.7900',
      currency: 'USD',
      status: 'captured',
      brand: 'Store balance',
    })
    .returning();
  return row!;
}

describe('the integrity check with customer wallets', () => {
  it('passes with every wallet posting in the books, a clawback below zero included, and corrects nothing', async () => {
    const customer = await insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera' });
    const serviceId = await insertAnyService(db);
    const orderId = await insertCustomerOrder(db, serviceId, customer.id, {
      currency: 'USD',
      totalPrice: '3.9900',
      taxAmount: '0.8000',
    });
    await post(
      customerTopup({
        customerId: customer.id,
        amount: Money.of('48.50'),
        fee: Money.of('1.50'),
        from: 'gateway_clearing',
      }),
      1,
      'deposit:payment:1',
    );
    const payment = await balancePayment(orderId, customer.id);
    await post(
      b2cWalletPay({ customerId: customer.id, net: Money.of('3.99'), vat: Money.of('0.80') }),
      orderId,
      `payment:${payment.id}:capture`,
    );
    await post(
      b2cWalletRefund({
        customerId: customer.id,
        net: Money.of('3.99'),
        vat: Money.of('0.80'),
        from: 'customer_funds',
      }),
      orderId,
      `order:${orderId}:refund`,
    );
    await post(
      customerAdjust({ customerId: customer.id, amount: Money.of('40'), direction: 'debit' }),
      customer.id,
      'adjust:customer:1:k',
    );
    // The clawback takes the wallet to −40.00; it must be frozen in the same transaction (the deferred trigger checks at commit).
    await db.transaction(async (tx) => {
      await postTransaction(
        tx,
        {
          ...topupChargeback({
            owner: { accountId: customer.id, kind: 'customer_wallet' },
            net: Money.of('48.50'),
            fee: Money.of('1.50'),
            disputeFee: Money.of('15'),
          }),
          refId: 1,
          idempotencyKey: 'dispute:1:chargeback',
          currency: 'USD',
          createdBy: { type: 'system', id: null },
          allowNegativeCustomerWallet: true,
        },
        clock.now(),
      );
      await tx
        .update(s.ledgerAccounts)
        .set({ frozenAt: clock.now(), frozenReason: 'Dispute' })
        .where(eq(s.ledgerAccounts.kind, 'customer_wallet'));
    });
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '-40.0000' });
    expect(await findBalanceDifferences(db)).toEqual([]);

    const before = await ledgerTotals(db);
    expect(before.sum).toBe('0.0000');
    await runJob();
    const body = await report();
    expect(body.result).toBe('pass');
    expect(
      body.checks.map((check: { key: string; status: string; count: number }) => [
        check.key,
        check.status,
        check.count,
      ]),
    ).toEqual([
      ['entries_balanced', 'pass', 0],
      ['accounts_match_lines', 'pass', 0],
      ['stuck_holds', 'pass', 0],
      ['payments_without_entry', 'pass', 0],
      ['wallets_follow_rank', 'pass', 0],
    ]);
    expect(await ledgerTotals(db)).toEqual(before);
  });

  it('finds a balance payment without its journal (no gateway: named Store balance)', async () => {
    const customer = await insertCustomer(db, { hasAccount: true });
    const serviceId = await insertAnyService(db);
    const orderId = await insertCustomerOrder(db, serviceId, customer.id, { currency: 'USD' });
    const payment = await balancePayment(orderId, customer.id);
    await runJob();
    const found = checkOf(await report(), 'payments_without_entry');
    expect(found).toMatchObject({ status: 'fail', count: 1, difference: '4.7900' });
    expect(found.findings[0]).toMatchObject({ kind: 'payment', id: payment.id, label: 'Payment · Store balance' });
  });

  it('labels a store balance whose balance differs from its lines with the account', async () => {
    const customer = await insertCustomer(db, { hasAccount: true, name: 'Daniel Rivera' });
    await post(
      customerTopup({ customerId: customer.id, amount: Money.of('10'), from: 'bank' }),
      1,
      'deposit:payment:1',
    );
    const wallet = await customerWalletRow(db, customer.id);
    await db.execute(sql`update ledger_accounts set balance = balance + 1 where id = ${wallet!.id}`);
    await runJob();
    const accounts = checkOf(await report(), 'accounts_match_lines');
    expect(accounts.status).toBe('fail');
    expect(accounts.findings[0]).toMatchObject({
      kind: 'account',
      id: wallet!.id,
      ref: `customer_wallet:${customer.id}`,
      label: 'Customer wallet · Daniel Rivera',
    });
  });
});
