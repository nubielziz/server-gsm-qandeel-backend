// Integration tests of the answers of the three password sign-in routes (decision 064): `POST /client/auth/sign-in` answers the area
// word, the next step and the rank of whoever signed in, and the two aliases (`POST /client/auth/login`, `POST /store/v1/auth/login`)
// answer the next step only. The use case itself (one argon2 verify, one budget, one lock) is tested with the sign-in service.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../../support/app';
import { ACCOUNT_SESSION_COOKIE, csrfCookieNameOf } from '../../support/account-sessions';
import { ACCOUNT_PASSWORD, makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import { MerchantPortal, PORTAL_ORIGIN, clearPortalRateLimits, seedPortalBasics } from '../../support/merchant-portal';
import { freshClientIp } from '../../support/pipeline-routes';
import { TURNSTILE_TEST_TOKEN, clearStoreRateLimits } from '../../support/store';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-11T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearStoreRateLimits(t);
  await seedPortalBasics();
});

const TURNSTILE = { 'x-turnstile-token': TURNSTILE_TEST_TOKEN };

/** A browser on the site with the portal's Origin (the site posts the sign-in form from there). */
const browser = () => new MerchantPortal(t, freshClientIp());
const post = (b: MerchantPortal, url: string, email: string, password = ACCOUNT_PASSWORD) =>
  b.call('POST', url, { email, password }, { csrf: false, headers: TURNSTILE });

describe('POST /client/auth/sign-in', () => {
  it('answers merchant, the next step and the merchant rank for a merchant account, and sets its cookies', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const b = browser();
    const res = await post(b, '/client/auth/sign-in', merchant.email);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      kind: 'merchant',
      next: 'done',
      rank: { id: merchant.groupId, name: expect.any(String), kind: 'merchant' },
    });
    expect(b.cookie(ACCOUNT_SESSION_COOKIE)).toBeString();
    expect(b.cookie(csrfCookieNameOf('merchant'))).toBeString();
    expect(b.cookie(csrfCookieNameOf('retail'))).toBeUndefined();
  });

  it('answers customer, the next step and the retail rank for a retail account, with the CSRF cookie of its kind', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const b = browser();
    const res = await post(b, '/client/auth/sign-in', retail.email);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'customer',
      next: 'done',
      rank: { id: retail.groupId, name: expect.any(String), kind: 'retail' },
    });
    expect(b.cookie(ACCOUNT_SESSION_COOKIE)).toBeString();
    expect(b.cookie(csrfCookieNameOf('retail'))).toBeString();
    expect(b.cookie(csrfCookieNameOf('merchant'))).toBeUndefined();
  });

  it('answers next password for a temporary password, whatever the rank', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', mustChangePassword: true });
    const retail = await makeAccount(t, { rank: 'retail', mustChangePassword: true });
    expect((await post(browser(), '/client/auth/sign-in', merchant.email)).json()).toMatchObject({ next: 'password' });
    expect((await post(browser(), '/client/auth/sign-in', retail.email)).json()).toMatchObject({ next: 'password' });
  });

  it('answers 401 for a wrong password, with no session cookie and no rank', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const b = browser();
    const res = await post(b, '/client/auth/sign-in', retail.email, 'not-the-password');
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('rank');
    expect(b.cookie(ACCOUNT_SESSION_COOKIE)).toBeUndefined();
  });
});

describe('the two aliases of the one sign-in', () => {
  it('answer only the next step on POST /client/auth/login, for either rank', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    expect((await post(browser(), '/client/auth/login', merchant.email)).json()).toEqual({ next: 'done' });
    expect((await post(browser(), '/client/auth/login', retail.email)).json()).toEqual({ next: 'done' });
  });

  it('answer only the next step on POST /store/v1/auth/login, for either rank', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    expect((await post(browser(), '/store/v1/auth/login', retail.email)).json()).toEqual({ next: 'done' });
    expect((await post(browser(), '/store/v1/auth/login', merchant.email)).json()).toEqual({ next: 'done' });
  });
});
