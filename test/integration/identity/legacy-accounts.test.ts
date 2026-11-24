// Integration tests of GET /admin/legacy-accounts/:type/:id (decision 064): which account an old merchant or customer number belongs to.
// An old customer number is never an account id, so the lookup must never hand back the account that merely has that number.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { makeAccount } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mapLegacyClient, mapLegacyCustomer } from '../../support/legacy-accounts';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/**
 * A merchant that kept its number, and a retail account that was customer number `merchant.id` before the accounts were merged: the old
 * customer number equals the merchant's account id on purpose.
 */
async function world() {
  const { db } = await testDb();
  const merchant = await makeAccount(t, { rank: 'merchant' });
  const customer = await makeAccount(t, { rank: 'retail' });
  await mapLegacyClient(db, merchant.id);
  await mapLegacyCustomer(db, merchant.id, customer.id);
  return { merchant, customer };
}

describe('GET /admin/legacy-accounts/:type/:id', () => {
  it('finds the account of an old customer number, and never the merchant that has the same number', async () => {
    const api = await adminWith(t, ['clients:read']);
    const { merchant, customer } = await world();
    const res = await api.get(`/admin/legacy-accounts/customer/${merchant.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId: customer.id });
    expect(res.body.accountId).not.toBe(merchant.id);
  });

  it('finds the account of an old merchant number: client and merchant are the same number space', async () => {
    const api = await adminWith(t, ['clients:read']);
    const { merchant } = await world();
    for (const type of ['client', 'merchant']) {
      const res = await api.get(`/admin/legacy-accounts/${type}/${merchant.id}`);
      expect(res.status, type).toBe(200);
      expect(res.body, type).toEqual({ accountId: merchant.id });
    }
  });

  it('answers 404 for a number nobody had, for a customer number of a merchant and for a word that is not an old kind', async () => {
    const api = await adminWith(t, ['clients:read']);
    const { merchant, customer } = await world();
    expect((await api.get('/admin/legacy-accounts/customer/999999')).status).toBe(404);
    expect((await api.get('/admin/legacy-accounts/client/999999')).status).toBe(404);
    // The customer's account id is not an old customer number (only the merchant's number was mapped as one).
    expect((await api.get(`/admin/legacy-accounts/customer/${customer.id}`)).status).toBe(404);
    // `account` is an id, not an old number: a console that asks about it learns nothing.
    expect((await api.get(`/admin/legacy-accounts/account/${merchant.id}`)).status).toBe(404);
    expect((await api.get(`/admin/legacy-accounts/staff/${merchant.id}`)).status).toBe(404);
  });

  it('answers 422 for an id that is not a positive whole number', async () => {
    const api = await adminWith(t, ['clients:read']);
    await world();
    for (const id of ['0', 'x', '1.5']) {
      expect((await api.get(`/admin/legacy-accounts/customer/${id}`)).status, id).toBe(422);
    }
  });

  it('needs clients:read', async () => {
    const { merchant } = await world();
    const none = await adminWith(t, ['orders:read']);
    expect((await none.get(`/admin/legacy-accounts/client/${merchant.id}`)).status).toBe(403);
    expect((await none.anonymous('GET', `/admin/legacy-accounts/client/${merchant.id}`)).status).toBe(401);
  });

  it('writes nothing: the map is read only', async () => {
    const api = await adminWith(t, ['clients:read']);
    const { merchant } = await world();
    const { db } = await testDb();
    const before = await db.select().from(s.accountLegacyIds);
    await api.get(`/admin/legacy-accounts/customer/${merchant.id}`);
    expect(await db.select().from(s.accountLegacyIds)).toEqual(before);
  });
});
