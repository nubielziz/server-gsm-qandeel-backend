// Integration tests of the two-step sign-in routes of a retail account (decision 064, POST /store/v1/me/2fa/setup, /enable and /disable)
// through HTTP on the real application: the same use case as `/client/security/2fa/*`, so a retail account sets up, confirms and turns off
// an authenticator, an account without a password is refused with 409, and a merchant rank is refused with 403 RANK_NOT_ALLOWED.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EncryptionService } from '@src/infra/crypto';
import { CLIENT_TOTP_AAD } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { openAccountSession } from '../../support/account-sessions';
import { accountRow, makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { codeFor } from '../../support/staff-console';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

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
  await clearStoreRateLimits(t);
});

const VERIFIED = new Date('2026-10-12T09:30:00.000Z');
const codeNow = (secret: string, steps = 0): Promise<string> => codeFor(secret, clock.nowMs() + steps * 30 * SECOND);
const problem = (res: { json: () => unknown }) => res.json() as { code: string };

/** A retail account with a password and a confirmed email, signed in through the shop. */
async function signedIn() {
  const customer = await makeCustomer(t, { emailVerifiedAt: VERIFIED });
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  return { customer, client };
}

describe('the two-step routes of a retail account', () => {
  it('sets up, confirms and turns off an authenticator, as /client/security/2fa does', async () => {
    const { customer, client } = await signedIn();

    const setup = await client.call('POST', '/store/v1/me/2fa/setup');
    expect(setup.statusCode).toBe(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    const { secret, otpauthUrl, qrSvg } = setup.json<{ secret: string; otpauthUrl: string; qrSvg: string }>();
    expect(otpauthUrl).toStartWith('otpauth://totp/');
    expect(qrSvg).toStartWith('<svg');
    const pending = await accountRow(customer.id);
    expect(pending.twofaEnabled).toBe(false);
    expect(t.app.get(EncryptionService).decrypt(pending.totpSecretEnc!, CLIENT_TOTP_AAD)).toBe(secret);

    const wrong = await client.call('POST', '/store/v1/me/2fa/enable', { code: '000000' });
    expect(wrong.statusCode).toBe(422);
    expect((await accountRow(customer.id)).twofaEnabled).toBe(false);

    const enabled = await client.call('POST', '/store/v1/me/2fa/enable', { code: await codeNow(secret) });
    expect(enabled.statusCode).toBe(204);
    expect(await accountRow(customer.id)).toMatchObject({ twofaEnabled: true });

    // The step of the code that confirmed the secret is spent: the next one turns it off.
    const off = await client.call('POST', '/store/v1/me/2fa/disable', { code: await codeNow(secret, 1) });
    expect(off.statusCode).toBe(204);
    expect(await accountRow(customer.id)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
  });

  it('refuses an account without a password with 409 and stores nothing', async () => {
    const customer = await makeCustomer(t, { noPassword: true, emailVerifiedAt: VERIFIED });
    const session = await openAccountSession(t, customer.id);
    const res = await t.app.inject({ method: 'POST', url: '/store/v1/me/2fa/setup', headers: session.mutationHeaders });
    expect(res.statusCode).toBe(409);
    expect(problem(res).code).toBe('CONFLICT');
    expect((await accountRow(customer.id)).totpSecretEnc).toBeNull();
  });

  it('refuses an account whose email is not confirmed with 409 and stores nothing', async () => {
    const customer = await makeCustomer(t);
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    const res = await client.call('POST', '/store/v1/me/2fa/setup');
    expect(res.statusCode).toBe(409);
    expect((await accountRow(customer.id)).totpSecretEnc).toBeNull();
  });

  it('needs the CSRF token and a session', async () => {
    const { client } = await signedIn();
    const noToken = await client.call('POST', '/store/v1/me/2fa/setup', undefined, { csrf: false });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
    const anonymous = new StoreClient(t, freshClientIp());
    expect((await anonymous.call('POST', '/store/v1/me/2fa/setup', undefined, { cookies: false })).statusCode).toBe(
      401,
    );
  });

  it('refuses a merchant rank with 403 RANK_NOT_ALLOWED on all three routes (it uses /client/security/2fa)', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', emailVerifiedAt: VERIFIED });
    const session = await openAccountSession(t, merchant.id);
    for (const [url, payload] of [
      ['/store/v1/me/2fa/setup', undefined],
      ['/store/v1/me/2fa/enable', { code: '123456' }],
      ['/store/v1/me/2fa/disable', { code: '123456' }],
    ] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: session.mutationHeaders,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, url).toBe(403);
      expect(problem(res).code, url).toBe('RANK_NOT_ALLOWED');
    }
    expect((await accountRow(merchant.id)).totpSecretEnc).toBeNull();
  });
});
