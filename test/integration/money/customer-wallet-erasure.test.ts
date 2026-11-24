// Integration tests of the money side of erasing an account (decision 064; feature 21, O12, risk K11): POST
// /admin/clients/:id/anonymize runs `WalletErasure.closeForErasure` last, which refuses (409 CONFLICT, nothing erased) while any wallet of the
// account or its hold is not zero, while a wallet is on hold, or while a top-up waits for review; voids the unpaid top-ups of either wallet
// kind; and lets an account without money go. The open-order and refund cases of the balance are `customer-anonymize-open-orders.test.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type Database, schema as s } from '@src/infra/db';
import { customerAdjust, postTransaction } from '@src/modules/money';
import { accountRow } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { customerWalletRow, fundCustomer, insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['customers:privacy']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const anonymize = (id: number) => staff.post(`/admin/clients/${id}/anonymize`, {});
const statusOf = async (id: number) => (await accountRow(id)).status;

/** A ledger account of the wallet kinds that a rank change can leave behind, with a balance a defect would leave on it. */
async function leftover(accountId: number, kind: 'client_wallet' | 'client_hold', balance: string): Promise<void> {
  await db
    .insert(s.ledgerAccounts)
    .values({ kind, ownerType: 'account', ownerId: accountId, currency: 'USD', balance });
}

/** Brings the store balance of an account to zero by a manual debit (posted directly, so this file does not depend on the unified wallet routes). */
async function debitAll(accountId: number, amount: string): Promise<void> {
  await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...customerAdjust({ customerId: accountId, amount: Money.of(amount), direction: 'debit' }),
        refId: accountId,
        idempotencyKey: `debit-all:${accountId}`,
        currency: 'USD',
        memo: 'Manual debit: Paid out before the erasure',
        createdBy: { type: 'system', id: null },
      },
      clock.now(),
    ),
  );
}

describe('POST /admin/clients/:id/anonymize, the money side', () => {
  it('lets a retail account without a wallet go', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    expect((await anonymize(customer.id)).status).toBe(204);
    expect(await statusOf(customer.id)).toBe('anonymized');
  });

  it('is refused while the store balance is not zero, and goes through once it is brought to zero', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    await fundCustomer(db, customer.id, '12.5');
    const refused = await anonymize(customer.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT' });
    expect(refused.body.detail).toContain('12.5000 USD');
    expect(await statusOf(customer.id)).toBe('active');

    await debitAll(customer.id, '12.5');
    expect((await anonymize(customer.id)).status).toBe(204);
    expect(await statusOf(customer.id)).toBe('anonymized');
    // The wallet row stays for the books, at zero.
    expect(await customerWalletRow(db, customer.id)).toMatchObject({ balance: '0.0000' });
  });

  it('is refused while the wallet is on hold, even at zero, and goes through once the hold is lifted', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    await fundCustomer(db, customer.id, '5');
    await debitAll(customer.id, '5');
    const wallet = await customerWalletRow(db, customer.id);
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: clock.now(), frozenReason: 'Checking a dispute' })
      .where(eq(s.ledgerAccounts.id, wallet!.id));
    const refused = await anonymize(customer.id);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain('on hold');
    expect(await statusOf(customer.id)).toBe('active');

    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: null, frozenReason: '' })
      .where(eq(s.ledgerAccounts.id, wallet!.id));
    expect((await anonymize(customer.id)).status).toBe(204);
  });

  it('is refused while a wallet or a hold of the other kind is not zero (the rank may have changed before)', async () => {
    const withWallet = await makeCustomer(t, { name: 'Wallet Left' });
    await leftover(withWallet.id, 'client_wallet', '30.0000');
    const wallet = await anonymize(withWallet.id);
    expect(wallet.status).toBe(409);
    expect(wallet.body.detail).toContain('30.0000 USD');

    const withHold = await makeCustomer(t, { name: 'Hold Left' });
    await leftover(withHold.id, 'client_hold', '5.0000');
    const hold = await anonymize(withHold.id);
    expect(hold.status).toBe(409);
    expect(hold.body.detail).toContain('5.0000 USD');
    expect(await statusOf(withWallet.id)).toBe('active');
    expect(await statusOf(withHold.id)).toBe('active');
  });

  it('is refused while a top-up payment waits for review, of either wallet kind', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const invoice = await insertInvoiceRow(db, customer.id, { walletKind: 'customer_wallet', legacyClientId: null });
    await insertPendingPayment(db, invoice, await insertGateway(t, db, { isManual: true }));
    const refused = await anonymize(customer.id);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain('waits for review');
    expect(await statusOf(customer.id)).toBe('active');
  });

  it('voids the unpaid top-ups of the account, whatever wallet kind they were for', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const store = await insertInvoiceRow(db, customer.id, {
      number: 'T-STORE-1',
      walletKind: 'customer_wallet',
      legacyClientId: null,
      idempotencyKey: 'store-1',
    });
    const merchant = await insertInvoiceRow(db, customer.id, {
      number: 'T-MERCHANT-1',
      walletKind: 'client_wallet',
      legacyClientId: null,
      idempotencyKey: 'merchant-1',
    });
    expect((await anonymize(customer.id)).status).toBe(204);
    const rows = await db
      .select({ id: s.invoices.id, status: s.invoices.status, idempotencyKey: s.invoices.idempotencyKey })
      .from(s.invoices)
      .where(and(eq(s.invoices.accountId, customer.id), eq(s.invoices.kind, 'topup')));
    expect(rows.map((row) => row.id).sort()).toEqual([store.id, merchant.id].sort());
    for (const row of rows) expect(row).toMatchObject({ status: 'void', idempotencyKey: null });
  });
});
