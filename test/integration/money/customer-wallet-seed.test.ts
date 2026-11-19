// Integration test of the customer wallet development seed (feature 21): the switch on, the CliQ gateway, a credited $50 top-up posted through
// the ledger and a top-up in review, balanced books, and a second run that adds nothing.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import { seedCustomerWallet } from '../../../scripts/seed/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { ledgerTotals } from '../../support/money';
import { insertCustomer } from '../../support/support';

beforeEach(resetDb);
afterAll(closeTestDb);

describe('seedCustomerWallet', () => {
  it('switches the wallet on, adds the gateway and two top-ups once, with balanced books', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const first = await insertCustomer(db, { hasAccount: true });
    const second = await insertCustomer(db, { hasAccount: true });
    await insertCustomer(db, { hasAccount: false });
    const now = new Date('2026-11-10T09:00:00.000Z');
    expect(await db.transaction((tx) => seedCustomerWallet(tx, now))).toMatchObject({ inserted: 2, existing: 0 });
    expect(await db.transaction((tx) => seedCustomerWallet(tx, now))).toMatchObject({ inserted: 0, existing: 2 });

    const [setting] = await db.select().from(s.settings).where(eq(s.settings.key, 'wallet.customer.enabled'));
    expect(setting!.value).toBe(true);
    const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.code, 'cliq'));
    expect(gateway).toMatchObject({ isManual: true, audience: 'b2c', minAmount: '5.0000', maxAmount: '500.0000' });
    const [credited] = await db.select().from(s.invoices).where(eq(s.invoices.customerId, first.id));
    const [waiting] = await db.select().from(s.invoices).where(eq(s.invoices.customerId, second.id));
    expect(credited).toMatchObject({ status: 'paid', amount: '50.0000' });
    expect(waiting).toMatchObject({ status: 'open' });
    const [pending] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, waiting!.id));
    expect(pending!.status).toBe('pending');
    const [wallet] = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.ownerId, first.id));
    expect(wallet).toMatchObject({ kind: 'customer_wallet', balance: '50.0000' });
    expect(await ledgerTotals(db)).toMatchObject({ sum: '0.0000', transactions: 1 });
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('does nothing without two customers with an account', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await insertCustomer(db, { hasAccount: true });
    expect(await db.transaction((tx) => seedCustomerWallet(tx, new Date()))).toMatchObject({ inserted: 0 });
  });
});
