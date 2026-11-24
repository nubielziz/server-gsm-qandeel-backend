// Integration tests of the one "me" shape (decision 064): `GET /client/auth/me` for an account of a merchant rank and
// `GET /store/v1/me` for an account of the retail rank answer the same `AccountMe` keys, with an empty `username` and `company` for the
// retail account, the rank in both, and each family refuses the other rank with 403 RANK_NOT_ALLOWED (a code that never signs anyone out).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../../support/app';
import { openAccountSession } from '../../support/account-sessions';
import { makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
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
});

/** The keys of `AccountMe` (the shared account keys, with the profile keys both routes send). */
const ACCOUNT_ME_KEYS = [
  'address',
  'company',
  'country',
  'createdAt',
  'currency',
  'email',
  'emailVerifiedAt',
  'hasPassword',
  'id',
  'marketingOptIn',
  'mustChangePassword',
  'name',
  'phone',
  'rank',
  'status',
  'taxId',
  'twofaEnabled',
  'username',
];

/** Opens a session for the account and calls a GET route the way the shop and the portal do. */
async function get(accountId: number, url: string) {
  const session = await openAccountSession(t, accountId);
  const res = await t.app.inject({ method: 'GET', url, headers: session.headers });
  return { res, session };
}

describe('GET /client/auth/me and GET /store/v1/me', () => {
  it('answer the same AccountMe keys for a merchant rank and for the retail rank', async () => {
    const merchant = await makeAccount(t, {
      rank: 'merchant',
      name: 'Ali Hassan',
      company: 'Hassan Mobile',
      phone: '+962791234567',
      country: 'JO',
      address: 'Amman',
      taxId: 'T-1',
    });
    const retail = await makeAccount(t, { rank: 'retail', name: 'Daniel Whitmore', country: 'GB' });

    const merchantMe = await get(merchant.id, '/client/auth/me');
    const retailMe = await get(retail.id, '/store/v1/me');
    expect(merchantMe.res.statusCode).toBe(200);
    expect(retailMe.res.statusCode).toBe(200);
    const fromMerchant = merchantMe.res.json<Record<string, unknown>>();
    const fromRetail = retailMe.res.json<Record<string, unknown>>();

    expect(Object.keys(fromMerchant).sort()).toEqual(ACCOUNT_ME_KEYS);
    expect(Object.keys(fromRetail).sort()).toEqual(ACCOUNT_ME_KEYS);
    expect(fromMerchant).not.toHaveProperty('group');
    expect(Object.keys(fromMerchant.rank as object).sort()).toEqual(['discountPercent', 'id', 'kind', 'name']);
    expect(Object.keys(fromRetail.rank as object).sort()).toEqual(['discountPercent', 'id', 'kind', 'name']);
  });

  it('says the rank kind of each account, and an empty username and company for the retail account', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', name: 'Ali Hassan', company: 'Hassan Mobile' });
    const retail = await makeAccount(t, { rank: 'retail', name: 'Daniel Whitmore' });
    const fromMerchant = (await get(merchant.id, '/client/auth/me')).res.json();
    const fromRetail = (await get(retail.id, '/store/v1/me')).res.json();

    expect(fromMerchant).toMatchObject({
      id: merchant.id,
      name: 'Ali Hassan',
      email: merchant.email,
      status: 'active',
      company: 'Hassan Mobile',
      username: merchant.row.username,
      rank: { id: merchant.groupId, kind: 'merchant' },
    });
    expect(merchant.row.username).toBeTruthy();
    expect(fromRetail).toMatchObject({
      id: retail.id,
      name: 'Daniel Whitmore',
      status: 'active',
      username: '',
      company: '',
      rank: { id: retail.groupId, kind: 'retail' },
    });
  });

  it('tell a password, a forced change, the two-step choice and the dates the same way on both routes', async () => {
    const verifiedAt = new Date('2026-10-12T09:30:00.000Z');
    const merchant = await makeAccount(t, { rank: 'merchant', mustChangePassword: true, emailVerifiedAt: verifiedAt });
    const retail = await makeAccount(t, { rank: 'retail', password: null });
    const fromMerchant = (await get(merchant.id, '/client/auth/me')).res.json();
    const fromRetail = (await get(retail.id, '/store/v1/me')).res.json();

    expect(fromMerchant).toMatchObject({
      hasPassword: true,
      mustChangePassword: true,
      twofaEnabled: false,
      emailVerifiedAt: '2026-10-12T09:30:00.000Z',
      createdAt: merchant.row.createdAt.toISOString(),
    });
    expect(fromRetail).toMatchObject({
      hasPassword: false,
      mustChangePassword: false,
      twofaEnabled: false,
      emailVerifiedAt: null,
      currency: null,
      marketingOptIn: false,
    });
  });

  it('are never cached and repeat the CSRF token of the session in the header', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    for (const [account, url] of [
      [merchant.id, '/client/auth/me'],
      [retail.id, '/store/v1/me'],
    ] as const) {
      const { res, session } = await get(account, url);
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.headers['x-csrf-token'], url).toBe(session.csrf);
    }
  });

  it('refuse the other rank with 403 RANK_NOT_ALLOWED, and answer 401 without a session', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    const retailOnClient = await get(retail.id, '/client/auth/me');
    expect(retailOnClient.res.statusCode).toBe(403);
    expect(retailOnClient.res.json<{ code: string }>().code).toBe('RANK_NOT_ALLOWED');
    const merchantOnStore = await get(merchant.id, '/store/v1/me');
    expect(merchantOnStore.res.statusCode).toBe(403);
    expect(merchantOnStore.res.json<{ code: string }>().code).toBe('RANK_NOT_ALLOWED');
    expect((await t.app.inject({ method: 'GET', url: '/client/auth/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/me' })).statusCode).toBe(401);
  });
});
