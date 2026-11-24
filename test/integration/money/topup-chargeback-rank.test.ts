// Integration tests of the clawback of a lost top-up dispute on the live wallet of an account of either rank (decision 064):
// a dispute opened on a card top-up holds the wallet of the account's rank kind now (a merchant wallet too, which then takes no new hold),
// a loss takes the credit back from it (a merchant wallet may pass its credit limit, a store balance goes below zero and stays frozen), and
// the books still reconcile.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import {
  AccountWallets,
  PaymentAutoCredit,
  PaymentAutoCreditModule,
  customerAdjust,
  postTransaction,
} from '@src/modules/money';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { hook } from '../../support/b2c';
import {
  FakeGateway,
  GatewayTestModule,
  WEBHOOK_KEY,
  cardEvent,
  insertGateway,
  postWebhook,
  signedHeaders,
} from '../../support/billing';
import { MINUTE, TestClock } from '../../support/clock';
import { customerWalletRow, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { rejectionOf } from '../../support/rejection';
import { insertUsd } from '../../support/fixtures';
import { accountFigures, insertWalletMerchant, ledgerTotals, placeOrderHold } from '../../support/money';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;
let job: PaymentAutoCredit;
let gatewayId: number;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, PaymentAutoCreditModule] });
  job = t.app.get(PaymentAutoCredit, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
  await walletSettings(t, db, { 'wallet.customer.card_topups': true });
  await insertWalletTemplates(db);
  gatewayId = await insertGateway(t, db, {
    code: 'card',
    name: 'Card',
    driver: 'card',
    audience: 'both',
    apiBase: fake.url,
  });
});

let invoiceCounter = 0;

/** A card top-up invoice of 50 USD (fee 1.50) of an account for the wallet kind named, confirmed by the gateway and credited by the job. */
async function topUp(accountId: number, walletKind: 'client_wallet' | 'customer_wallet') {
  invoiceCounter += 1;
  const [invoice] = await db
    .insert(s.invoices)
    .values({
      number: `INV-2026-${String(invoiceCounter).padStart(4, '0')}`,
      accountId,
      walletKind,
      ...(walletKind === 'client_wallet' ? { legacyClientId: accountId } : {}),
      kind: 'topup',
      amount: '50.0000',
      fee: '1.5000',
      netAmount: '48.5000',
      total: '50.0000',
      currency: 'USD',
      gatewayId,
      checkoutUrl: 'https://pay.example/cs_1',
    })
    .returning();
  const reference = `pi_${crypto.randomUUID()}`;
  fake.paid(reference, { minor: 5000, reference: invoice!.number });
  const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice!.number, { reference, amount: 5000 });
  expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);
  clock.advance(10 * MINUTE);
  expect(await job.run(await job.due())).toMatchObject({ credited: 1 });
  const [payment] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, invoice!.id));
  return { invoice: invoice!, payment: payment!, reference };
}

/** A signed card dispute event on a USD payment of 50. */
function dispute(reference: string, type: 'created' | 'lost' = 'created'): string {
  return JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    type: type === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_1',
        payment_intent: reference,
        amount: 5000,
        currency: 'usd',
        fee: 1500,
        reason: 'fraudulent',
        status: type === 'created' ? 'needs_response' : type,
      },
    },
  });
}

const send = async (body: string) => {
  const res = await hook(t, clock, 'disputes', 'card', body);
  expect(res.statusCode).toBe(200);
};

/** The lines of one journal by its key: account kind and signed amount (debit above zero), sorted by kind. */
async function journal(key: string): Promise<Array<{ account: string; amount: string }>> {
  const result = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount
        from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key} order by a.kind`,
  );
  return result.rows;
}

/** The merchant wallet row of an account. */
async function merchantWalletRow(accountId: number) {
  const [row] = await db
    .select()
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.kind, 'client_wallet'),
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
      ),
    );
  return row;
}

describe('a dispute of a top-up of an account whose live wallet is a merchant wallet', () => {
  it('created holds the merchant wallet and refuses the next hold; the loss takes the credit back below the credit limit', async () => {
    const merchant = await insertWalletMerchant(db, {
      name: 'Zain Mobile Hub',
      creditLimit: '10',
      overdraftAllowed: true,
    });
    const { payment, reference } = await topUp(merchant.id, 'client_wallet');
    // The merchant spent what it topped up: the wallet is at zero and the price sits in the hold.
    await placeOrderHold(db, merchant.id, '48.5');
    expect((await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id }))!.balance).toBe('0.0000');

    await send(dispute(reference));
    // A repeated delivery of the opening holds nothing again: the dispute is the guard of the system freeze.
    await send(dispute(reference));
    const [row] = await db.select().from(s.disputes);
    expect(row).toMatchObject({
      paymentId: payment.id,
      orderId: null,
      accountId: merchant.id,
      status: 'needs_response',
    });
    const held = await merchantWalletRow(merchant.id);
    expect(held!.frozenAt).not.toBeNull();
    expect(held!.frozenReason).toBe(`Dispute DP-${row!.id} on PAY-${payment.id}`);
    // The next hold of a portal or a Dhru order stops at the frozen wallet (409 WALLET_FROZEN); the hold that exists is not touched.
    const refused = await rejectionOf(
      db.transaction((tx) => t.app.get(AccountWallets, { strict: false }).assertNotFrozen(tx, merchant.id)),
    );
    expect(refused).toMatchObject({ code: 'WALLET_FROZEN' });
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'froze wallet of'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'account', entityId: merchant.id, actorType: 'system' });
    // A merchant gets no store-balance mail.
    expect(await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.frozen'))).toHaveLength(0);

    await send(dispute(reference, 'lost'));
    expect(await journal(`dispute:${row!.id}:chargeback`)).toEqual([
      { account: 'chargeback_loss', amount: '15.0000' },
      { account: 'client_wallet', amount: '48.5000' },
      { account: 'fee_income', amount: '1.5000' },
      { account: 'gateway_clearing', amount: '-65.0000' },
    ]);
    // The wallet went to -48.50, below its credit limit of 10: the one posting that may.
    const after = await merchantWalletRow(merchant.id);
    expect(after).toMatchObject({ balance: '-48.5000', overdraftLimit: '10.0000' });
    expect(after!.frozenAt).not.toBeNull();
    expect((await db.select().from(s.disputes))[0]).toMatchObject({ status: 'lost' });
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]!.status).toBe('approved');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('a dispute of a top-up that was never credited holds the wallet too and posts nothing on the loss', async () => {
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    invoiceCounter += 1;
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        number: `INV-2026-${String(invoiceCounter).padStart(4, '0')}`,
        accountId: merchant.id,
        walletKind: 'client_wallet',
        legacyClientId: merchant.id,
        kind: 'topup',
        amount: '50.0000',
        fee: '1.5000',
        netAmount: '48.5000',
        total: '50.0000',
        currency: 'USD',
        gatewayId,
      })
      .returning();
    const reference = `pi_${crypto.randomUUID()}`;
    fake.paid(reference, { minor: 5000, reference: invoice!.number });
    const body = cardEvent(`evt_${crypto.randomUUID()}`, invoice!.number, { reference, amount: 5000 });
    expect((await postWebhook(t, 'card', body, signedHeaders(WEBHOOK_KEY, body, clock))).statusCode).toBe(200);

    await send(dispute(reference));
    expect((await merchantWalletRow(merchant.id))!.frozenAt).not.toBeNull();
    await send(dispute(reference, 'lost'));
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.kind, 'chargeback'))).toEqual([]);
    const [payment] = await db.select().from(s.payments);
    expect(payment).toMatchObject({ status: 'rejected', autoCreditAt: null });
    expect((await accountFigures(db, 'client_wallet', { type: 'account', id: merchant.id }))!.balance).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('a dispute of a top-up of an account whose live wallet is a store balance', () => {
  it('created holds the balance and the loss takes the credit back below zero as it always did, the balance staying frozen', async () => {
    const account = await makeAccount({ rank: 'retail', name: 'Daniel Rivera', db });
    const { payment, reference } = await topUp(account.id, 'customer_wallet');
    expect((await customerWalletRow(db, account.id))!.balance).toBe('48.5000');
    // Spent: a debit takes the balance back to zero before the loss.
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...customerAdjust({ customerId: account.id, amount: Money.of('48.5'), direction: 'debit' }),
          refId: account.id,
          idempotencyKey: `spend:${crypto.randomUUID()}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        new Date(),
      ),
    );

    await send(dispute(reference));
    const [row] = await db.select().from(s.disputes);
    expect(row).toMatchObject({ paymentId: payment.id, accountId: account.id });
    const held = await customerWalletRow(db, account.id);
    expect(held!.frozenAt).not.toBeNull();
    expect(held!.frozenReason).toBe(`Dispute DP-${row!.id} on PAY-${payment.id}`);
    expect(await db.select().from(s.notifications).where(eq(s.notifications.event, 'wallet.frozen'))).toHaveLength(1);

    await send(dispute(reference, 'lost'));
    expect(await journal(`dispute:${row!.id}:chargeback`)).toEqual([
      { account: 'chargeback_loss', amount: '15.0000' },
      { account: 'customer_wallet', amount: '48.5000' },
      { account: 'fee_income', amount: '1.5000' },
      { account: 'gateway_clearing', amount: '-65.0000' },
    ]);
    const after = await customerWalletRow(db, account.id);
    expect(after!.balance).toBe('-48.5000');
    expect(after!.frozenAt).not.toBeNull();
    expect(await merchantWalletRow(account.id)).toBeUndefined();
  });
});
