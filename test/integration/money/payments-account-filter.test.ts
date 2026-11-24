// Integration tests of the filters of the top-up list that name an account (decision 064): `accountId` keeps the top-ups of one
// account of either rank, `clientId` is its alias, `customerId` is retired and answers 422, and `owner` is told by the wallet kind of
// the invoice, never by which owner column is empty. Each row carries the account id in its `client` or `customer` join.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '@src/infra/db';
import { makeAccount } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['payments:read']);
});

/** What the list needs: a merchant, a retail account, one gateway, and the payments made after the accounts merged. */
async function world() {
  const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const retail = await makeAccount({ rank: 'retail', name: 'Daniel Rivera', db });
  const gatewayId = await insertGateway(t, db, { name: 'Bank transfer', isManual: true, audience: 'both' });
  const topUp = async (
    accountId: number,
    walletKind: 'client_wallet' | 'customer_wallet',
    reference: string,
  ): Promise<number> => {
    const invoice = await insertInvoiceRow(db, accountId, {
      amount: '50.0000',
      gatewayId,
      walletKind,
      ...(walletKind === 'client_wallet' ? {} : { legacyClientId: null }),
    });
    return (await insertPendingPayment(db, invoice, gatewayId, { methodType: 'bank', gatewayTxnId: reference })).id;
  };
  const merchantFirst = await topUp(merchant.id, 'client_wallet', 'TRX-M1');
  const merchantSecond = await topUp(merchant.id, 'client_wallet', 'TRX-M2');
  const retailFirst = await topUp(retail.id, 'customer_wallet', 'TRX-R1');
  return { merchant, retail, gatewayId, merchantFirst, merchantSecond, retailFirst, topUp };
}

const idsOf = (body: Array<{ id: number }>): number[] => body.map((row) => row.id).sort((a, b) => a - b);

describe('GET /admin/payments filters on the account', () => {
  it('answers 422 to the retired customerId filter, whatever its value', async () => {
    const { retail } = await world();
    const res = await staff.get(`/admin/payments?customerId=${retail.id}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).toContain('customerId');
  });

  it('accountId lists the top-ups of one account of either kind, each row carrying the account id in its own join', async () => {
    const { merchant, retail, merchantFirst, merchantSecond, retailFirst } = await world();

    const ofRetail = await staff.get(`/admin/payments?accountId=${retail.id}`);
    expect(ofRetail.status).toBe(200);
    expect(idsOf(ofRetail.body)).toEqual([retailFirst]);
    expect(ofRetail.body[0]).toMatchObject({ client: null, customer: { id: retail.id, name: 'Daniel Rivera' } });
    expect(ofRetail.total).toBe(1);

    const ofMerchant = await staff.get(`/admin/payments?accountId=${merchant.id}`);
    expect(idsOf(ofMerchant.body)).toEqual([merchantFirst, merchantSecond]);
    expect(ofMerchant.body[0]).toMatchObject({ customer: null, client: { id: merchant.id, name: 'Zain Mobile Hub' } });
    expect(ofMerchant.total).toBe(2);
  });

  it('clientId is the alias of accountId: it answers the same rows, for an account of either kind', async () => {
    const { merchant, retail } = await world();
    for (const account of [merchant, retail]) {
      const byAccount = await staff.get(`/admin/payments?accountId=${account.id}&_sort=id&_order=asc`);
      const byAlias = await staff.get(`/admin/payments?clientId=${account.id}&_sort=id&_order=asc`);
      expect(byAlias.status).toBe(200);
      expect(byAlias.body).toEqual(byAccount.body);
      expect(byAlias.body.length).toBeGreaterThan(0);
    }
  });

  it('an account that made no top-up has an empty list, not an error', async () => {
    const { retail } = await world();
    const other = await makeAccount({ rank: 'retail', db });
    expect((await staff.get(`/admin/payments?accountId=${other.id}`)).body).toEqual([]);
    expect(retail.id).not.toBe(other.id);
  });

  it('owner is told by the wallet kind of the invoice: an account that changed kind keeps its old top-up under the old owner', async () => {
    const { retail, merchantFirst, merchantSecond, retailFirst, topUp } = await world();
    // The retail account was a merchant when it made this one: the invoice names its merchant wallet.
    const oldDeposit = await topUp(retail.id, 'client_wallet', 'TRX-R-OLD');

    const merchants = await staff.get('/admin/payments?owner=merchant');
    expect(idsOf(merchants.body)).toEqual([merchantFirst, merchantSecond, oldDeposit].sort((a, b) => a - b));
    const customers = await staff.get('/admin/payments?owner=customer');
    expect(idsOf(customers.body)).toEqual([retailFirst]);

    // The row of the old deposit shows the account in the `client` join, with no balance (its live wallet is a store balance now).
    const row = merchants.body.find((payment: { id: number }) => payment.id === oldDeposit);
    expect(row).toMatchObject({ customer: null, client: { id: retail.id, walletBalance: null } });
    // Both filters together keep the intersection.
    const both = await staff.get(`/admin/payments?owner=merchant&accountId=${retail.id}`);
    expect(idsOf(both.body)).toEqual([oldDeposit]);
  });

  it('q finds the top-ups of an account of either rank by its name', async () => {
    const { merchantFirst, merchantSecond, retailFirst } = await world();
    expect(idsOf((await staff.get('/admin/payments?q=Daniel')).body)).toEqual([retailFirst]);
    expect(idsOf((await staff.get('/admin/payments?q=Zain')).body)).toEqual([merchantFirst, merchantSecond]);
  });
});
