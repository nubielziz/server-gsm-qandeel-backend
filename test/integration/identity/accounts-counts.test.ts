// Integration tests of GET /admin/clients/counts (decision 064): the numbers of the chips and the header sentence of the Accounts page,
// from one aggregate over every account.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ensureRetailGroup, makeAccount } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';

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
 * Six rows: an active merchant with a password, a suspended merchant that has none, an active retail account that waits for its first
 * password, a blocked retail account, an anonymized retail account and a guest.
 */
async function rows() {
  const { db } = await testDb();
  await ensureRetailGroup(db);
  await makeAccount(t, { rank: 'merchant' });
  await makeAccount(t, { rank: 'merchant', status: 'suspended', password: null });
  await makeAccount(t, { rank: 'retail', password: null });
  await makeAccount(t, { rank: 'retail', status: 'blocked' });
  await makeAccount(t, {
    rank: 'retail',
    status: 'anonymized',
    anonymizedAt: new Date('2026-06-01T09:00:00.000Z'),
    password: null,
  });
  await makeAccount(t, { rank: 'retail', guest: true });
}

const COUNTS = {
  all: 6,
  retail: 4,
  merchant: 2,
  guests: 1,
  active: 3,
  suspended: 1,
  blocked: 1,
  anonymized: 1,
  invitationPending: 1,
};

describe('GET /admin/clients/counts', () => {
  it('counts every account in one aggregate: by rank kind, guests, status and invitations that wait', async () => {
    await rows();
    const api = await adminWith(t, ['clients:read']);
    const res = await api.get('/admin/clients/counts');
    expect(res.status).toBe(200);
    // Guests hold the retail rank, so they are counted in retail; a suspended account that has no password is not an invitation.
    expect(res.body).toEqual(COUNTS);
  });

  it('agrees with the totals of the list under the matching filters', async () => {
    await rows();
    const api = await adminWith(t, ['clients:read']);
    const totalOf = async (query: string) => (await api.get(`/admin/clients?_end=1${query}`)).total;
    expect(await totalOf('')).toBe(COUNTS.all);
    expect(await totalOf('&rankKind=retail')).toBe(COUNTS.retail);
    expect(await totalOf('&rankKind=merchant')).toBe(COUNTS.merchant);
    expect(await totalOf('&hasAccount=false')).toBe(COUNTS.guests);
    expect(await totalOf('&status=active')).toBe(COUNTS.active);
    expect(await totalOf('&status=suspended')).toBe(COUNTS.suspended);
    expect(await totalOf('&status=blocked')).toBe(COUNTS.blocked);
    expect(await totalOf('&status=anonymized')).toBe(COUNTS.anonymized);
    expect(await totalOf('&invitationPending=true')).toBe(COUNTS.invitationPending);
  });

  it('is read again at every call: a new account shows at once, nothing is cached', async () => {
    await rows();
    const api = await adminWith(t, ['clients:read']);
    expect((await api.get('/admin/clients/counts')).body.all).toBe(6);
    await makeAccount(t, { rank: 'merchant', password: null });
    const after = await api.get('/admin/clients/counts');
    expect(after.body).toMatchObject({ all: 7, merchant: 3, active: 4, invitationPending: 2 });
  });

  it('counts zero for everything on an empty table', async () => {
    const api = await adminWith(t, ['clients:read']);
    const { db } = await testDb();
    await ensureRetailGroup(db);
    expect((await api.get('/admin/clients/counts')).body).toEqual({
      all: 0,
      retail: 0,
      merchant: 0,
      guests: 0,
      active: 0,
      suspended: 0,
      blocked: 0,
      anonymized: 0,
      invitationPending: 0,
    });
  });

  it('needs clients:read', async () => {
    const none = await adminWith(t, ['orders:read']);
    expect((await none.get('/admin/clients/counts')).status).toBe(403);
    expect((await none.anonymous('GET', '/admin/clients/counts')).status).toBe(401);
  });
});
