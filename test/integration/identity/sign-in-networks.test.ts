// Integration tests of decision 052, rule one: every per-email sign-in counter (staff, merchant and customer login, the one sign-in
// form, the two forgot-password routes and the sign-in link) counts per email and network: the IPv4 address or the IPv6 /64.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  clearPortalRateLimits,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientIp, freshClientPrefix } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN, StaffConsole, makeStaff } from '../../support/staff-console';
import {
  STORE_ORIGIN,
  StoreClient,
  TURNSTILE_TEST_TOKEN,
  clearStoreRateLimits,
  makeCustomer,
} from '../../support/store';

const clock = new TestClock('2026-11-21T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` },
    clock,
  });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearStoreRateLimits(t);
  await seedPortalBasics();
});

const WRONG = 'not-the-password';
const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.com`;

/** One flow: what it answers while the budget lasts, and how to call it from an address. */
interface Flow {
  readonly name: string;
  readonly usual: number;
  readonly email: () => Promise<string>;
  readonly call: (ip: string, email: string) => Promise<LightMyRequestResponse>;
}

const FLOWS: readonly Flow[] = [
  {
    name: 'staff login (POST /admin/auth/login)',
    usual: 401,
    email: async () => (await makeStaff(t)).email,
    call: (ip, email) => new StaffConsole(t, ip).login(email, WRONG),
  },
  {
    name: 'merchant login (POST /client/auth/login)',
    usual: 401,
    email: async () => (await makeMerchant(t)).email,
    call: (ip, email) => new MerchantPortal(t, ip).login(email, WRONG),
  },
  {
    name: 'customer login (POST /store/v1/auth/login)',
    usual: 401,
    email: async () => (await makeCustomer(t)).email,
    call: (ip, email) => new StoreClient(t, ip).login(email, WRONG),
  },
  {
    name: 'the one sign-in form (POST /client/auth/sign-in)',
    usual: 401,
    email: async () => (await makeCustomer(t)).email,
    call: (ip, email) =>
      new MerchantPortal(t, ip).call(
        'POST',
        '/client/auth/sign-in',
        { email, password: WRONG },
        { csrf: false, headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } },
      ),
  },
  {
    name: 'merchant forgot password',
    usual: 204,
    email: async () => (await makeMerchant(t)).email,
    call: (ip, email) => new MerchantPortal(t, ip).forgot(email),
  },
  {
    name: 'customer forgot password',
    usual: 204,
    email: async () => (await makeCustomer(t)).email,
    call: (ip, email) => new StoreClient(t, ip).forgot(email),
  },
  {
    name: 'customer sign-in link',
    usual: 204,
    email: async () => (await makeCustomer(t)).email,
    call: (ip, email) => new StoreClient(t, ip).magicLink(email),
  },
];

describe('per-email counters count per network (decision 052)', () => {
  for (const flow of FLOWS) {
    it(`${flow.name}: five addresses of one /64 share one budget, another /64 has its own`, async () => {
      const email = await flow.email();
      const prefix = freshClientPrefix();
      for (let i = 1; i <= 5; i++) {
        expect((await flow.call(`${prefix}::${i}`, email)).statusCode, `try ${i}`).toBe(flow.usual);
      }
      // A sixth interface id inside the same /64 is the same network.
      const sixth = await flow.call(`${prefix}:aaaa:bbbb:cccc:dddd`, email);
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json<{ code: string }>().code).toBe('RATE_LIMITED');
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // Another /64 is another network.
      expect((await flow.call(`${freshClientPrefix()}::1`, email)).statusCode).toBe(flow.usual);
    });
  }

  it('keeps one budget per IPv4 address: another address of the same /24 is not charged', async () => {
    const email = (await makeMerchant(t)).email;
    const first = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await new MerchantPortal(t, first).login(email, WRONG)).statusCode).toBe(401);
    expect((await new MerchantPortal(t, first).login(email, WRONG)).statusCode).toBe(429);
    expect((await new MerchantPortal(t, freshClientIp()).login(email, WRONG)).statusCode).toBe(401);
  });

  it('counts an unknown email the same way, so the 429 tells nothing', async () => {
    const email = uniqueEmail('nobody');
    const prefix = freshClientPrefix();
    for (let i = 1; i <= 5; i++)
      expect((await new StaffConsole(t, `${prefix}::${i}`).login(email, WRONG)).statusCode).toBe(401);
    expect((await new StaffConsole(t, `${prefix}::99`).login(email, WRONG)).statusCode).toBe(429);
  });
});
