// Integration tests of the anti-bot check on the public merchant sign-up, sign-in and forgot-password routes (feature 24A, decision 034
// amendment) with TURNSTILE_MERCHANT_AUTH on: a missing or bad token is refused before anything else, the dummy token passes. With the
// switch off (the default outside production) the routes answer as before: the existing merchant tests and
// test/integration/customers/smart-sign-in.test.ts show it. In production the switch is on unless it is set to false (decision 052).
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { PasswordHasher } from '@src/infra/crypto';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, productionEnvOnTestInstances } from '../../support/auth';
import { closeTestDb, resetDb } from '../../support/db';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  clearPortalRateLimits,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientIp } from '../../support/pipeline-routes';
import { TURNSTILE_TEST_TOKEN } from '../../support/store';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN, TURNSTILE_MERCHANT_AUTH: 'true' } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await seedPortalBasics();
});

const WITH_TOKEN = { headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } };
const BAD_TOKEN = { headers: { 'x-turnstile-token': 'not-the-dummy-token' } };
const code = (res: { json: () => unknown }) => (res.json() as { code: string }).code;
const registration = (email: string) => ({
  name: 'Ali Hassan',
  email,
  password: 'a-long-enough-password-1',
  country: 'JO',
});

describe('TURNSTILE_MERCHANT_AUTH=true', () => {
  it('refuses register, login and forgot without a token or with a bad one: 403 TURNSTILE_FAILED, nothing set', async () => {
    const merchant = await makeMerchant(t);
    const p = new MerchantPortal(t, freshClientIp());
    for (const options of [{}, BAD_TOKEN]) {
      const answers = [
        await p.register(registration('new-merchant@example.com'), options),
        await p.login(merchant.email, undefined, options),
        await p.forgot(merchant.email, options),
      ];
      for (const res of answers) {
        expect(res.statusCode).toBe(403);
        expect(code(res)).toBe('TURNSTILE_FAILED');
        expect(res.cookies).toEqual([]);
      }
    }
  });

  it('checks the token before the body, the counters and the password hash', async () => {
    const merchant = await makeMerchant(t);
    const ip = freshClientIp();
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    try {
      // An invalid body is still 403, not 422: the guard runs before validation.
      expect(code(await new MerchantPortal(t, ip).login('', ''))).toBe('TURNSTILE_FAILED');
      // Ten refused tries charge no sign-in counter: the eleventh, with a token, signs in.
      for (let i = 0; i < 10; i++)
        expect((await new MerchantPortal(t, ip).login(merchant.email, 'wrong-password')).statusCode).toBe(403);
      expect(verify).not.toHaveBeenCalled();
      const res = await new MerchantPortal(t, ip).login(merchant.email, undefined, WITH_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ next: 'done' });
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('lets register, login and forgot through with the dummy token, answering as before', async () => {
    const merchant = await makeMerchant(t);
    const p = new MerchantPortal(t, freshClientIp());
    expect((await p.register(registration('another-merchant@example.com'), WITH_TOKEN)).statusCode).toBe(204);
    expect((await p.forgot(merchant.email, WITH_TOKEN)).statusCode).toBe(204);
    const login = await p.login(merchant.email, undefined, WITH_TOKEN);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: 'done' });
    expect((await p.me()).statusCode).toBe(200);
  });

  it('leaves the merchant routes that are not flagged alone (verify-email, reset)', async () => {
    const p = new MerchantPortal(t, freshClientIp());
    expect(code(await p.verifyEmail('no-such-token'))).toBe('TOKEN_INVALID');
    expect(code(await p.reset('no-such-token', 'a-long-enough-password-1'))).toBe('TOKEN_INVALID');
  });
});

describe('TURNSTILE_MERCHANT_AUTH in production (decision 052)', () => {
  /** A production app on the test instances; `extra` may set the switch. */
  const productionApp = (extra: Record<string, string> = {}) =>
    createTestApp({ env: productionEnvOnTestInstances({ SHOP_ORIGINS: PORTAL_ORIGIN, ...extra }) });

  it('is on by default: register, login and forgot without a token are 403 TURNSTILE_FAILED before any counter or hash', async () => {
    const production = await productionApp();
    const hasher = production.app.get(PasswordHasher);
    const verify = spyOn(hasher, 'verify');
    const hash = spyOn(hasher, 'hash');
    try {
      const merchant = await makeMerchant(production);
      verify.mockClear();
      hash.mockClear();
      const p = new MerchantPortal(production, freshClientIp());
      for (const res of [
        await p.register(registration('new-merchant@example.com')),
        await p.login(merchant.email),
        await p.forgot(merchant.email),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(code(res)).toBe('TURNSTILE_FAILED');
        expect(res.cookies).toEqual([]);
      }
      expect(verify).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
      hash.mockRestore();
      await production.close();
    }
  });

  it('answers as before without a token when TURNSTILE_MERCHANT_AUTH is false', async () => {
    const production = await productionApp({ TURNSTILE_MERCHANT_AUTH: 'false' });
    try {
      const merchant = await makeMerchant(production);
      const p = new MerchantPortal(production, freshClientIp());
      expect((await p.register(registration('another-merchant@example.com'))).statusCode).toBe(204);
      expect((await p.forgot(merchant.email)).statusCode).toBe(204);
      const login = await p.login(merchant.email);
      expect(login.statusCode, login.body).toBe(200);
      expect(login.json()).toEqual({ next: 'done' });
    } finally {
      await production.close();
    }
  });
});
