// Integration tests of decision 052, rule two: password sign-in attempts are counted per email across networks before the password is
// checked, and after ten failures the next attempt locks the email for 15 minutes for every network the account has not signed in from
// (staff on the console; merchants and customers share one shop lock). A correct password takes back only its own count. A new password
// from an emailed link or one staff set ends the lock; a merchant's own change does not. While a lock runs, the attempts a network the
// account used is still allowed share one budget per network (five in 15 minutes).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys } from '@src/infra/cache';
import { DbService } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { SessionService, StaffAuthTokens } from '@src/modules/identity';
import type { SubjectType } from '@src/modules/identity/db/schema';
import { SignInFailures } from '@src/modules/identity/infra/sign-in-failures';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb } from '../../support/db';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  emailedLinks,
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
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
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
afterEach(() => mock.restore());

const WRONG = 'not-the-password';
const NEW_PASSWORD = 'a-brand-new-passphrase';
type Call = (ip: string, email: string, password: string) => Promise<LightMyRequestResponse>;

/** An address in a network nobody used in this run (a new IPv6 /64). */
const stranger = () => `${freshClientPrefix()}::1`;
const uniqueEmail = (label: string) => `${label}-${randomUUID()}@example.com`;
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
const withoutRequestId = (res: LightMyRequestResponse) => {
  const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>();
  return rest;
};

/** Ten failed attempts for an email, each from a network of its own, so only the email's lock can refuse the next one. */
async function lockOut(call: Call, email: string): Promise<void> {
  for (let i = 0; i < 10; i++) expect((await call(stranger(), email, WRONG)).statusCode, `failure ${i + 1}`).toBe(401);
}

/** Expects the refusal of a locked email: 429 with the time left of the lock. */
function expectLocked(res: LightMyRequestResponse, retryAfter = 15 * 60): void {
  expect(res.statusCode, res.body).toBe(429);
  expect(res.json<{ code: string }>().code).toBe('RATE_LIMITED');
  expect(Number(res.headers['retry-after'])).toBe(retryAfter);
}

/** A full sign-in of the account from an address, as a session row that sign-in writes. */
async function pastSignIn(subjectType: SubjectType, subjectId: number, ip: string): Promise<void> {
  await t.app.get(SessionService).create({ subjectType, subjectId, stage: 'active', ip, userAgent: 'bun-test' });
}

describe('the console (staff)', () => {
  it('locks the email after ten failures from ten networks: the right password from an eleventh is 429 for 15 minutes', async () => {
    const staff = await makeStaff(t);
    await lockOut(staffLogin, staff.email);
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
    clock.advance(5 * MINUTE);
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD), 10 * 60);
  });

  it('lets a network the account signed in from sign in while the lock runs, and keeps the lock for the others', async () => {
    const staff = await makeStaff(t);
    const home = freshClientPrefix();
    await pastSignIn('staff', staff.id, `${home}::1`);
    await lockOut(staffLogin, staff.email);
    const own = await staffLogin(`${home}::2`, staff.email, PASSWORD);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ next: 'totp' });
    // A success from a familiar network does not reopen the door for strangers.
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
  });

  it('lets a new network try again once the lock has ended', async () => {
    const staff = await makeStaff(t);
    await lockOut(staffLogin, staff.email);
    // The first attempt after ten failures is refused and starts the 15 minutes.
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
    clock.advance(15 * MINUTE + SECOND);
    expect((await staffLogin(stranger(), staff.email, PASSWORD)).statusCode).toBe(200);
  });

  it('ends the lock when the member sets a password by an emailed link', async () => {
    const staff = await makeStaff(t);
    await lockOut(staffLogin, staff.email);
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
    const { token } = await t.app
      .get(DbService)
      .runInTransaction((work) => t.app.get(StaffAuthTokens).issue(work, { staffId: staff.id, purpose: 'reset' }));
    const set = await new StaffConsole(t, stranger()).setPassword({ token, password: NEW_PASSWORD }, { csrf: false });
    expect(set.statusCode, set.body).toBe(204);
    expect((await staffLogin(stranger(), staff.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('ends the lock when another member sets a temporary password', async () => {
    const staff = await makeStaff(t);
    await lockOut(staffLogin, staff.email);
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
    const owner = await adminWith(t, ['*']);
    const res = await owner.post(`/admin/staff/${staff.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const temporary = (res.body as { temporaryPassword: string }).temporaryPassword;
    expect((await staffLogin(stranger(), staff.email, temporary)).statusCode).toBe(200);
  });

  it('counts the console apart from the shop: a locked staff email does not lock the same email on the shop', async () => {
    const email = uniqueEmail('both-sides');
    await makeStaff(t, { email });
    await makeCustomer(t, { email });
    await lockOut(staffLogin, email);
    expect((await storeLogin(stranger(), email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
  });
});

describe('the shop (merchants and customers)', () => {
  it('locks a merchant email on POST /client/auth/login, and the lock holds on the one sign-in form and the store login', async () => {
    const merchant = await makeMerchant(t);
    await lockOut(merchantLogin, merchant.email);
    expectLocked(await merchantLogin(stranger(), merchant.email, MERCHANT_PASSWORD));
    expectLocked(await smartSignIn(stranger(), merchant.email, MERCHANT_PASSWORD));
    expectLocked(await storeLogin(stranger(), merchant.email, MERCHANT_PASSWORD));
  });

  it('lets a merchant sign in from a network of a past session while its email is locked', async () => {
    const merchant = await makeMerchant(t);
    const home = freshClientPrefix();
    await pastSignIn('client', merchant.id, `${home}::1`);
    await lockOut(smartSignIn, merchant.email);
    expect((await merchantLogin(`${home}::abcd`, merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expectLocked(await merchantLogin(stranger(), merchant.email, MERCHANT_PASSWORD));
  });

  it('lets the customer who owns the email sign in from the network of a real past sign-in while strangers locked it', async () => {
    const customer = await makeCustomer(t);
    const home = freshClientPrefix();
    expect((await storeLogin(`${home}::1`, customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
    await lockOut(storeLogin, customer.email);
    expectLocked(await storeLogin(stranger(), customer.email, CUSTOMER_PASSWORD));
    const own = await storeLogin(`${home}::2`, customer.email, CUSTOMER_PASSWORD);
    expect(own.statusCode, own.body).toBe(200);
    // The same through the one sign-in form.
    expect((await smartSignIn(`${home}::3`, customer.email, CUSTOMER_PASSWORD)).json()).toEqual({
      kind: 'customer',
      next: 'done',
    });
    expectLocked(await smartSignIn(stranger(), customer.email, CUSTOMER_PASSWORD));
  });

  it('treats an address in the IPv4 /24 of a past sign-in as familiar, and one in the next /24 as a stranger', async () => {
    const customer = await makeCustomer(t);
    await pastSignIn('customer', customer.id, '198.51.100.7');
    await lockOut(storeLogin, customer.email);
    expect((await storeLogin('198.51.100.200', customer.email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
    expectLocked(await storeLogin('198.51.101.7', customer.email, CUSTOMER_PASSWORD));
  });

  it('ends a merchant lock with a new password from the forgot-password link', async () => {
    captureEmailedLinks(t);
    const merchant = await makeMerchant(t);
    await lockOut(merchantLogin, merchant.email);
    expectLocked(await merchantLogin(stranger(), merchant.email, MERCHANT_PASSWORD));
    expect((await new MerchantPortal(t, stranger()).forgot(merchant.email)).statusCode).toBe(204);
    const link = emailedLinks().at(-1)!;
    expect((await new MerchantPortal(t, stranger()).reset(link.token, NEW_PASSWORD)).statusCode).toBe(204);
    expect((await merchantLogin(stranger(), merchant.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('ends a customer lock with a new password from the forgot-password link', async () => {
    captureCustomerLinks(t);
    const customer = await makeCustomer(t);
    await lockOut(storeLogin, customer.email);
    expect((await new StoreClient(t, stranger()).forgot(customer.email)).statusCode).toBe(204);
    const link = customerLinks().at(-1)!;
    expect((await new StoreClient(t, stranger()).setPassword(link.token, NEW_PASSWORD)).statusCode).toBe(204);
    expect((await storeLogin(stranger(), customer.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('ends a merchant lock when staff set a temporary password', async () => {
    const merchant = await makeMerchant(t);
    await lockOut(merchantLogin, merchant.email);
    expectLocked(await merchantLogin(stranger(), merchant.email, MERCHANT_PASSWORD));
    const staff = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    const res = await staff.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const temporary = (res.body as { temporaryPassword: string }).temporaryPassword;
    expect((await merchantLogin(stranger(), merchant.email, temporary)).json()).toEqual({ next: 'password' });
  });

  it('keeps the shop lock when the merchant finishes a forced password change', async () => {
    const merchant = await makeMerchant(t);
    const home = freshClientPrefix();
    await pastSignIn('client', merchant.id, `${home}::1`);
    const staff = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    const set = await staff.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const temporary = (set.body as { temporaryPassword: string }).temporaryPassword;

    // Other networks lock the email after the temporary password was set; the merchant signs in from a network it used.
    await lockOut(merchantLogin, merchant.email);
    expectLocked(await merchantLogin(stranger(), merchant.email, temporary));
    const owner = new MerchantPortal(t, `${home}::2`);
    expect((await owner.login(merchant.email, temporary)).json()).toEqual({ next: 'password' });
    const changed = await owner.changeTemporaryPassword(NEW_PASSWORD);
    expect(changed.statusCode, changed.body).toBe(200);

    expectLocked(await merchantLogin(stranger(), merchant.email, NEW_PASSWORD));
    expectLocked(await smartSignIn(stranger(), merchant.email, NEW_PASSWORD));
    expectLocked(await storeLogin(stranger(), merchant.email, NEW_PASSWORD));
  });

  it('ends a customer lock when staff set a temporary password', async () => {
    const customer = await makeCustomer(t);
    await lockOut(storeLogin, customer.email);
    const staff = await adminWith(t, ['customers:read', 'customers:password']);
    const res = await staff.post(`/admin/customers/${customer.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const temporary = (res.body as { temporaryPassword: string }).temporaryPassword;
    expect((await storeLogin(stranger(), customer.email, temporary)).json()).toEqual({ next: 'password' });
  });
});

describe('the attempts a familiar network is still allowed while the email is locked', () => {
  // Fixed documentation networks (IPv4 /24s): the per-address sign-in limit of each address stays apart, so only the shared budget of
  // the network can refuse the sixth attempt.
  const HOME = '203.0.113';
  const OTHER_HOME = '192.0.2';
  const at = (network: string, host: number) => `${network}.${host}`;

  /** Locks the email from strangers and starts the lock (the first attempt after ten failures is refused). */
  async function lockFromStrangers(call: Call, email: string): Promise<void> {
    await lockOut(call, email);
    expectLocked(await call(stranger(), email, WRONG));
  }

  it('share one budget per network: five addresses of the /24 are checked, the sixth is 429 before its password is looked at, a second familiar network is still checked', async () => {
    const staff = await makeStaff(t);
    await pastSignIn('staff', staff.id, at(HOME, 7));
    await pastSignIn('staff', staff.id, at(OTHER_HOME, 7));
    await lockFromStrangers(staffLogin, staff.email);

    for (let host = 11; host <= 15; host++) {
      expect((await staffLogin(at(HOME, host), staff.email, WRONG)).statusCode, `address ${host}`).toBe(401);
    }
    expectLocked(await staffLogin(at(HOME, 16), staff.email, WRONG));
    // Refused before the password is checked: the right one gets the same answer.
    expectLocked(await staffLogin(at(HOME, 17), staff.email, PASSWORD));
    // Another network the account used has a budget of its own.
    expect((await staffLogin(at(OTHER_HOME, 11), staff.email, WRONG)).statusCode).toBe(401);
    const second = await staffLogin(at(OTHER_HOME, 12), staff.email, PASSWORD);
    expect(second.statusCode, second.body).toBe(200);
  });

  it('lets the right password sign in from the familiar network while its attempts are not used up', async () => {
    const staff = await makeStaff(t);
    await pastSignIn('staff', staff.id, at(HOME, 7));
    await lockFromStrangers(staffLogin, staff.email);

    for (let host = 11; host <= 14; host++) {
      expect((await staffLogin(at(HOME, host), staff.email, WRONG)).statusCode, `address ${host}`).toBe(401);
    }
    const own = await staffLogin(at(HOME, 15), staff.email, PASSWORD);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ next: 'totp' });
    // The lock still runs for the others.
    expectLocked(await staffLogin(stranger(), staff.email, PASSWORD));
  });

  it('on the shop, the store login and the one sign-in form draw on the same budget', async () => {
    const customer = await makeCustomer(t);
    await pastSignIn('customer', customer.id, at(HOME, 7));
    await lockFromStrangers(storeLogin, customer.email);

    for (let host = 11; host <= 13; host++) {
      expect((await storeLogin(at(HOME, host), customer.email, WRONG)).statusCode, `address ${host}`).toBe(401);
    }
    for (let host = 14; host <= 15; host++) {
      expect((await smartSignIn(at(HOME, host), customer.email, WRONG)).statusCode, `address ${host}`).toBe(401);
    }
    expectLocked(await storeLogin(at(HOME, 16), customer.email, CUSTOMER_PASSWORD));
    expectLocked(await smartSignIn(at(HOME, 17), customer.email, CUSTOMER_PASSWORD));
  });

  it('gives the count of a refused attempt back: the budget never feeds the lock after it has ended', async () => {
    const staff = await makeStaff(t);
    await pastSignIn('staff', staff.id, at(HOME, 7));
    await lockFromStrangers(staffLogin, staff.email);
    for (let host = 11; host <= 15; host++) {
      expect((await staffLogin(at(HOME, host), staff.email, WRONG)).statusCode, `address ${host}`).toBe(401);
    }
    for (let host = 16; host <= 25; host++) expectLocked(await staffLogin(at(HOME, host), staff.email, WRONG));

    clock.advance(15 * MINUTE + SECOND);
    // The five guesses that were checked stay counted; the ten that were refused do not.
    expect((await staffLogin(stranger(), staff.email, WRONG)).statusCode).toBe(401);
  });
});

describe('an attempt refused while the lock runs is not counted', () => {
  const cases: ReadonlyArray<readonly [string, Call, () => Promise<{ email: string }>]> = [
    ['the console', staffLogin, () => makeStaff(t)],
    ['the merchant login', merchantLogin, () => makeMerchant(t)],
    ['the store login', storeLogin, () => makeCustomer(t)],
  ];
  for (const [label, call, make] of cases) {
    it(`${label}: after the lock ends, a new network's next wrong password is 401, not 429`, async () => {
      const { email } = await make();
      await lockOut(call, email);
      expectLocked(await call(stranger(), email, WRONG));
      // More refused attempts than the lock allows failures: if they counted, the lock would start again at once.
      for (let i = 0; i < 15; i++) expectLocked(await call(stranger(), email, WRONG));

      clock.advance(15 * MINUTE + SECOND);
      expect((await call(stranger(), email, WRONG)).statusCode).toBe(401);
    });
  }
});

describe('a locked email answers alike for every email', () => {
  it('on the console: an account and an unknown email get the same answer', async () => {
    const staff = await makeStaff(t);
    const unknown = uniqueEmail('nobody');
    const answers: LightMyRequestResponse[] = [];
    for (const [email, password] of [
      [staff.email, PASSWORD],
      [unknown, PASSWORD],
    ] as const) {
      await lockOut(staffLogin, email);
      answers.push(await staffLogin(stranger(), email, password));
    }
    for (const res of answers) expectLocked(res);
    expect(withoutRequestId(answers[1]!)).toEqual(withoutRequestId(answers[0]!));
  });

  it('on the shop: a merchant, a customer, both and nobody get the same answer', async () => {
    const merchantOnly = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const customerOnly = await makeCustomer(t);
    const both = uniqueEmail('both');
    await makeMerchant(t, { email: both, emailVerifiedAt: new Date() });
    await makeCustomer(t, { email: both });
    const kinds = [
      [merchantOnly.email, MERCHANT_PASSWORD],
      [customerOnly.email, CUSTOMER_PASSWORD],
      [both, MERCHANT_PASSWORD],
      [uniqueEmail('nobody'), MERCHANT_PASSWORD],
    ] as const;
    const answers: LightMyRequestResponse[] = [];
    for (const [email, password] of kinds) {
      await lockOut(smartSignIn, email);
      answers.push(await smartSignIn(stranger(), email, password));
    }
    for (const res of answers) expectLocked(res);
    for (const res of answers) expect(withoutRequestId(res)).toEqual(withoutRequestId(answers[0]!));
  });
});

describe("a merchant with a password on a customer's email (no mailbox proven)", () => {
  const SQUATTER_PASSWORD = 'the-squatters-own-passphrase';

  /** A customer with a password, and a pending merchant on the same email whose email was never verified (a row written before decision 062). */
  async function sharedEmail(): Promise<string> {
    const email = uniqueEmail('shared');
    await makeCustomer(t, { email });
    await makeMerchant(t, { email, status: 'pending', emailVerifiedAt: null, password: SQUATTER_PASSWORD });
    return email;
  }

  it('cannot cancel the failures counted against the customer by signing in as the merchant', async () => {
    const email = await sharedEmail();
    for (let i = 0; i < 9; i++)
      expect((await storeLogin(stranger(), email, WRONG)).statusCode, `failure ${i + 1}`).toBe(401);
    expect((await merchantLogin(stranger(), email, SQUATTER_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await storeLogin(stranger(), email, WRONG)).statusCode).toBe(401);
    expectLocked(await storeLogin(stranger(), email, CUSTOMER_PASSWORD));
    expectLocked(await smartSignIn(stranger(), email, CUSTOMER_PASSWORD));
  });

  it("gets at most ten guesses at the customer's password, however often the merchant signs in between", async () => {
    const email = await sharedEmail();
    const statuses: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 9; i++) statuses.push((await storeLogin(stranger(), email, WRONG)).statusCode);
      expect((await merchantLogin(stranger(), email, SQUATTER_PASSWORD)).statusCode).not.toBe(401);
    }
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
    expectLocked(await storeLogin(stranger(), email, CUSTOMER_PASSWORD));
  });

  it("cannot end a running lock by changing the merchant's own password", async () => {
    const email = await sharedEmail();
    const squatter = new MerchantPortal(t, stranger());
    expect((await squatter.login(email, SQUATTER_PASSWORD)).statusCode).toBe(200);
    await lockOut(storeLogin, email);
    expectLocked(await storeLogin(stranger(), email, CUSTOMER_PASSWORD));
    const changed = await squatter.changePassword(SQUATTER_PASSWORD, NEW_PASSWORD);
    expect(changed.statusCode, changed.body).toBe(204);
    expectLocked(await storeLogin(stranger(), email, CUSTOMER_PASSWORD));
    expectLocked(await smartSignIn(stranger(), email, CUSTOMER_PASSWORD));
  });
});

describe('attempts sent at the same moment', () => {
  const cases: ReadonlyArray<readonly [string, Call, () => Promise<{ email: string }>, string]> = [
    ['the console', staffLogin, () => makeStaff(t), PASSWORD],
    ['the merchant login', merchantLogin, () => makeMerchant(t), MERCHANT_PASSWORD],
    ['the store login', storeLogin, () => makeCustomer(t), CUSTOMER_PASSWORD],
    ['the one sign-in form', smartSignIn, () => makeCustomer(t), CUSTOMER_PASSWORD],
  ];
  for (const [label, call, make, password] of cases) {
    it(`${label}: forty wrong passwords from forty networks at once are checked at most ten times, the rest are 429`, async () => {
      const { email } = await make();
      const answers = await Promise.all(Array.from({ length: 40 }, () => call(stranger(), email, WRONG)));
      const statuses = answers.map((res) => res.statusCode);
      const checked = statuses.filter((status) => status === 401).length;
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBeLessThanOrEqual(10);
      expect(statuses.filter((status) => status === 429)).toHaveLength(40 - checked);
      expectLocked(await call(stranger(), email, password));
    });
  }
});

describe('the count on the cache Redis', () => {
  it('takes back one attempt at a time, never below 0, and makes no key for an email with nothing counted', async () => {
    const failures = t.app.get(SignInFailures);
    const redis = t.app.get(RedisService).cache;
    const pattern = `${t.app.get(CacheKeys).keyspace}identity:sign-in-failures:*`;
    await failures.giveBack('shop', uniqueEmail('nothing-counted'));
    expect(await redis.keys(pattern)).toEqual([]);

    const email = uniqueEmail('counted');
    expect(await failures.charge('shop', email)).toEqual({ attempts: 1, lockedForSeconds: 0 });
    expect(await failures.charge('shop', email)).toEqual({ attempts: 2, lockedForSeconds: 0 });
    for (let i = 0; i < 3; i++) await failures.giveBack('shop', email);
    const [key] = await redis.keys(pattern);
    expect(await redis.hget(key!, 'n')).toBe('0');
    expect(await redis.pttl(key!)).toBeGreaterThan(0);
    expect(await failures.charge('shop', email)).toEqual({ attempts: 1, lockedForSeconds: 0 });
  });
});
