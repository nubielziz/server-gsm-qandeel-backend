// Integration tests of decision 052: a temporary password set by staff works for 72 hours (staff, accounts of a merchant rank and accounts of
// the retail rank, on every password sign-in route); after that it is refused exactly like a wrong password, and the refusal counts towards the
// email's lock. Staff set the password of every account with the one route `POST /admin/clients/:id/password` (decision 064).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { LightMyRequestResponse } from 'fastify';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  clearPortalRateLimits,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientPrefix } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN, PASSWORD, StaffConsole, makeStaff } from '../../support/staff-console';
import {
  CUSTOMER_PASSWORD,
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

const WRONG_DETAIL = 'The email or password is not correct.';
type Call = (ip: string, email: string, password: string) => Promise<LightMyRequestResponse>;
const stranger = () => `${freshClientPrefix()}::1`;
const staffLogin: Call = (ip, email, password) => new StaffConsole(t, ip).login(email, password);
const merchantLogin: Call = (ip, email, password) => new MerchantPortal(t, ip).login(email, password);
const storeLogin: Call = (ip, email, password) => new StoreClient(t, ip).login(email, password);
const smartSignIn: Call = (ip, email, password) =>
  new MerchantPortal(t, ip).call(
    'POST',
    '/client/auth/sign-in',
    { email, password },
    { csrf: false, headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } },
  );

/** The temporary password the staff route answers once. */
function temporaryPasswordOf(answer: { status: number; body: unknown }): string {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { temporaryPassword: string }).temporaryPassword;
}

/** An account with a temporary password set by staff through the real route, and the routes it signs in on. */
interface Kind {
  readonly name: string;
  readonly make: () => Promise<{ email: string; temporary: string }>;
  readonly routes: readonly Call[];
  /** What a sign-in with the temporary password answers while it is valid (the first route). */
  readonly pending: unknown;
}

const KINDS: readonly Kind[] = [
  {
    name: 'staff',
    make: async () => {
      const member = await makeStaff(t);
      const owner = await adminWith(t, ['*']);
      const answer = await owner.post(`/admin/staff/${member.id}/password`, {
        mode: 'temporary_password',
        revokeSessions: false,
      });
      return { email: member.email, temporary: temporaryPasswordOf(answer) };
    },
    routes: [staffLogin],
    pending: { next: 'password' },
  },
  {
    name: 'merchant',
    make: async () => {
      const merchant = await makeMerchant(t);
      const staff = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
      const answer = await staff.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' });
      return { email: merchant.email, temporary: temporaryPasswordOf(answer) };
    },
    routes: [merchantLogin, smartSignIn],
    pending: { next: 'password' },
  },
  {
    name: 'customer',
    make: async () => {
      const customer = await makeCustomer(t);
      const staff = await adminWith(t, ['clients:read', 'clients:security']);
      const answer = await staff.post(`/admin/clients/${customer.id}/password`, {
        mode: 'temporary_password',
        revokeSessions: false,
      });
      return { email: customer.email, temporary: temporaryPasswordOf(answer) };
    },
    routes: [storeLogin, smartSignIn],
    pending: { next: 'password' },
  },
];

for (const kind of KINDS) {
  describe(`a temporary password of a ${kind.name}`, () => {
    it('signs in for 72 hours and is refused like a wrong password from then on, on every password route', async () => {
      const { email, temporary } = await kind.make();
      clock.advance(72 * HOUR - MINUTE);
      const valid = await kind.routes[0]!(stranger(), email, temporary);
      expect(valid.statusCode, valid.body).toBe(200);
      expect(valid.json()).toMatchObject(kind.pending as Record<string, unknown>);

      clock.advance(MINUTE);
      for (const route of kind.routes) {
        const expired = await route(stranger(), email, temporary);
        expect(expired.statusCode, expired.body).toBe(401);
        expect(expired.json()).toMatchObject({ code: 'UNAUTHORIZED', detail: WRONG_DETAIL });
        expect(expired.cookies).toEqual([]);
      }
    });

    it('counts an expired temporary password towards the lock of the email', async () => {
      const { email, temporary } = await kind.make();
      clock.advance(72 * HOUR);
      for (let i = 0; i < 10; i++) expect((await kind.routes[0]!(stranger(), email, temporary)).statusCode).toBe(401);
      const locked = await kind.routes[0]!(stranger(), email, temporary);
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBe(15 * 60);
    });
  });
}

describe('a password the owner chose', () => {
  it('never expires: staff, merchant and customer sign in long after 72 hours', async () => {
    const member = await makeStaff(t, { passwordChangedAt: clock.now() });
    const merchant = await makeMerchant(t, { passwordChangedAt: clock.now() });
    const customer = await makeCustomer(t);
    clock.advance(30 * 24 * HOUR);
    expect((await staffLogin(stranger(), member.email, PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await merchantLogin(stranger(), merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await storeLogin(stranger(), customer.email, CUSTOMER_PASSWORD)).json()).toEqual({ next: 'done' });
    // The one sign-in answers the old `kind` word until the contract release, and the rank with its kind (decision 064).
    expect((await smartSignIn(stranger(), customer.email, CUSTOMER_PASSWORD)).json()).toEqual({
      kind: 'customer',
      next: 'done',
      rank: { id: expect.any(Number), name: expect.any(String), kind: 'retail' },
    });
  });
});
