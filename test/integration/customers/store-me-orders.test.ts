// Integration tests of `GET /store/v1/me/orders` (decision 064): the retail account's own shop orders, through the orders module's
// `ShopOrders` port, never another account's and never a portal order; a merchant rank is refused with 403 RANK_NOT_ALLOWED.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../../support/app';
import { openAccountSession } from '../../support/account-sessions';
import { makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertAnyService, insertCustomerOrder, insertStoreCurrencies } from '../../support/customers';
import { insertOrderRow } from '../../support/orders';
import { STORE_ORIGIN } from '../../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  // The orders name their currency by code (a foreign key): USD and GBP exist before any order does.
  await insertStoreCurrencies((await testDb()).db);
});

/** Calls the list as the account, with the session cookie of the one account type. */
async function listOf(accountId: number, query = '') {
  const session = await openAccountSession(t, accountId);
  return t.app.inject({ method: 'GET', url: `/store/v1/me/orders${query}`, headers: session.headers });
}

describe('GET /store/v1/me/orders', () => {
  it("lists the account's own shop orders, newest first, with the total in the header", async () => {
    const { db } = await testDb();
    const serviceId = await insertAnyService(db, 'Vodafone UK iPhone Unlock');
    const retail = await makeAccount(t, { rank: 'retail' });
    const first = await insertCustomerOrder(db, serviceId, retail.id, {
      status: 'completed',
      completedAt: new Date('2026-11-06T10:00:00.000Z'),
    });
    const second = await insertCustomerOrder(db, serviceId, retail.id, { status: 'processing' });

    const res = await listOf(retail.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    const rows =
      res.json<Array<{ id: number; status: string; service: { id: number; name: string }; currency: string }>>();
    expect(rows.map((row) => row.id)).toEqual([second, first]);
    expect(rows[0]).toMatchObject({
      status: 'processing',
      service: { id: serviceId, name: 'Vodafone UK iPhone Unlock' },
      currency: 'GBP',
    });
    expect(rows[1]).toMatchObject({ status: 'completed' });
  });

  it("never shows another account's shop order, and never a portal order", async () => {
    const { db } = await testDb();
    const serviceId = await insertAnyService(db);
    const retail = await makeAccount(t, { rank: 'retail' });
    const other = await makeAccount(t, { rank: 'retail' });
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const mine = await insertCustomerOrder(db, serviceId, retail.id);
    await insertCustomerOrder(db, serviceId, other.id);
    await insertOrderRow(db, { serviceId, accountId: merchant.id, source: 'portal' });

    const res = await listOf(retail.id);
    expect(res.json<Array<{ id: number }>>().map((row) => row.id)).toEqual([mine]);
    expect(res.headers['x-total-count']).toBe('1');
    const otherRows = (await listOf(other.id)).json<Array<{ id: number }>>();
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]!.id).not.toBe(mine);
  });

  it('filters by status and sorts by the total price', async () => {
    const { db } = await testDb();
    const serviceId = await insertAnyService(db);
    const retail = await makeAccount(t, { rank: 'retail' });
    const cheap = await insertCustomerOrder(db, serviceId, retail.id, { status: 'completed', totalPrice: '5.0000' });
    const dear = await insertCustomerOrder(db, serviceId, retail.id, { status: 'completed', totalPrice: '9.0000' });
    await insertCustomerOrder(db, serviceId, retail.id, { status: 'processing', totalPrice: '7.0000' });

    const completed = await listOf(retail.id, '?status=completed&_sort=totalPrice&_order=desc');
    expect(completed.statusCode).toBe(200);
    expect(completed.json<Array<{ id: number }>>().map((row) => row.id)).toEqual([dear, cheap]);
  });

  it('refuses a merchant rank with 403 RANK_NOT_ALLOWED and a request without a session with 401', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const refused = await listOf(merchant.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('RANK_NOT_ALLOWED');
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/me/orders' })).statusCode).toBe(401);
  });
});
