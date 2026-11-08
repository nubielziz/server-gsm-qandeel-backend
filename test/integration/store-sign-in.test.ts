// Integration tests of the storefront customer's sign-in (feature 14b, routes POST /store/v1/auth/login, /magic-link, /verify,
// /password/forgot, /password/set, /logout and POST /store/v1/me/password) through HTTP on the real application: the flows the
// storefront runs, every refusal the contracts list, no account enumeration, single-use links and the lock after repeated failures.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { CSRF_COOKIE_NAMES, SESSION_COOKIE_NAMES, csrfTokenFor } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import { insertBlock } from '../support/risk';
import {
  CUSTOMER_PASSWORD,
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
  makeCustomer,
} from '../support/store';

/** The app's clock: link lifetimes, lock times and session lifetimes follow it (decision 031). */
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
  captureCustomerLinks(t);
});
afterEach(() => mock.restore());

const store = (ip?: string) => new StoreClient(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
const sessionsOf = async (customerId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, customerId)).orderBy(asc(s.sessions.id));
};
const withoutRequestId = (res: { json: () => unknown }) => {
  const { requestId: _requestId, ...rest } = res.json() as Record<string, unknown>;
  return rest;
};

describe('POST /store/v1/auth/login', () => {
  it('signs a customer in: cookies, CSRF token, a full session, last_login_at from the clock', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    const res = await client.login(customer.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: 'done' });
    expect(res.headers['cache-control']).toBe('no-store');

    const sessionCookie = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.customer)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(sessionCookie.maxAge).toBeGreaterThan(29 * 24 * 3600);
    const csrfCookie = res.cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAMES.customer)!;
    expect(csrfCookie.httpOnly).toBeFalsy();
    const expectedCsrf = csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(client.sessionToken!));
    expect(csrfCookie.value).toBe(expectedCsrf);
    expect(res.headers['x-csrf-token']).toBe(expectedCsrf);

    expect(await sessionsOf(customer.id)).toMatchObject([{ subjectType: 'customer', stage: 'active' }]);
    expect((await customerRow(customer.id)).lastLoginAt?.toISOString()).toBe('2026-11-07T10:00:00.000Z');
    expect((await client.me()).statusCode).toBe(200);
  });

  it('gives an unknown email, a wrong password, an account with no password and a guest the same 401', async () => {
    const known = await makeCustomer(t);
    const noPassword = await makeCustomer(t, { noPassword: true });
    const guest = await makeCustomer(t, { guest: true });
    const answers = [
      await store().login('nobody@example.com'),
      await store().login(known.email, 'not-the-password'),
      await store().login(noPassword.email),
      await store().login(guest.email),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.cookies).toEqual([]);
      expect(withoutRequestId(res)).toEqual(withoutRequestId(answers[0]!));
    }
    expect(problem(answers[0]!).code).toBe('UNAUTHORIZED');
  });

  it('says ACCOUNT_SUSPENDED only after a correct password, for a suspended and a blocked customer', async () => {
    const suspended = await makeCustomer(t, { status: 'suspended' });
    const blocked = await makeCustomer(t, { status: 'blocked' });
    for (const customer of [suspended, blocked]) {
      const right = await store().login(customer.email);
      expect(right.statusCode).toBe(403);
      expect(problem(right).code).toBe('ACCOUNT_SUSPENDED');
      expect(right.cookies).toEqual([]);
      expect((await store().login(customer.email, 'not-the-password')).statusCode).toBe(401);
      expect(await sessionsOf(customer.id)).toHaveLength(0);
    }
  });

  it('treats an anonymized customer as unknown', async () => {
    const customer = await makeCustomer(t, { status: 'anonymized', hasAccount: false });
    expect((await store().login(customer.email)).statusCode).toBe(401);
  });

  it('opens a pending_password session after a temporary password: only the password change and logout work', async () => {
    const customer = await makeCustomer(t, { mustChangePassword: true });
    const client = store();
    const res = await client.login(customer.email);
    expect(res.json()).toEqual({ next: 'password' });
    expect(await sessionsOf(customer.id)).toMatchObject([{ stage: 'pending_password' }]);
    expect((await client.me()).statusCode).toBe(401);
    expect((await client.orders()).statusCode).toBe(401);
    expect((await client.logout()).statusCode).toBe(204);
  });

  it('counts attempts per email and address: the sixth is 429 with Retry-After, and a success clears the count', async () => {
    const customer = await makeCustomer(t);
    const ip = freshClientIp();
    for (let i = 0; i < 4; i++) expect((await store(ip).login(customer.email, 'wrong-password')).statusCode).toBe(401);
    expect((await store(ip).login(customer.email)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await store(ip).login(customer.email, 'wrong-password')).statusCode).toBe(401);
    const locked = await store(ip).login(customer.email);
    expect(locked.statusCode).toBe(429);
    expect(problem(locked).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another address is not locked out by that limiter.
    expect((await store().login(customer.email)).statusCode).toBe(200);
  });

  it('locks the email for 15 minutes after ten wrong passwords in a row, from any address, and unlocks by the clock', async () => {
    const customer = await makeCustomer(t);
    for (let i = 0; i < 10; i++) expect((await store().login(customer.email, 'wrong-password')).statusCode).toBe(401);

    // Even the right password is refused while locked, with the time left.
    const locked = await store().login(customer.email);
    expect(locked.statusCode).toBe(429);
    expect(problem(locked).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBe(15 * 60);
    // The same email in other letters is the same lock.
    expect((await store().login(customer.email.toUpperCase())).statusCode).toBe(429);
    clock.advance(10 * MINUTE);
    expect(Number((await store().login(customer.email)).headers['retry-after'])).toBe(5 * 60);

    clock.advance(5 * MINUTE + 1000);
    expect((await store().login(customer.email)).statusCode).toBe(200);
    // A new lock needs ten new failures.
    for (let i = 0; i < 9; i++) await store().login(customer.email, 'wrong-password');
    expect((await store().login(customer.email)).statusCode).toBe(200);
  });

  it('answers a known email, an unknown email, a guest and an account with no password the same way, tries and lock alike', async () => {
    const known = await makeCustomer(t);
    const noPassword = await makeCustomer(t, { noPassword: true });
    const guest = await makeCustomer(t, { guest: true });
    const anonymized = await makeCustomer(t, { status: 'anonymized', hasAccount: false });
    const emails = [known.email, noPassword.email, guest.email, anonymized.email, `nobody-${randomUUID()}@example.com`];

    const answers = [];
    for (const email of emails) {
      // Every try comes from a new address, so only the lock of the email can refuse.
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await store().login(email, 'wrong-password')).statusCode);
      const locked = await store().login(email, CUSTOMER_PASSWORD);
      answers.push({
        statuses,
        locked: {
          status: locked.statusCode,
          retryAfter: locked.headers['retry-after'],
          body: withoutRequestId(locked),
        },
      });
    }
    expect(answers[0]!.statuses).toEqual([...Array(10).fill(401), 429, 429]);
    expect(answers[0]!.locked).toMatchObject({ status: 429, retryAfter: String(15 * 60) });
    for (const answer of answers) expect(answer).toEqual(answers[0]!);
  });

  it('keeps no address in Redis, and a correct password clears the count', async () => {
    const customer = await makeCustomer(t);
    for (let i = 0; i < 9; i++) await store().login(customer.email, 'wrong-password');
    const redis = t.app.get(RedisService).cache;
    const pattern = `${t.app.get(CacheKeys).keyspace}customers:sign-in-failures:*`;
    const found = await redis.keys(pattern);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain(customer.email.split('@')[0]!);
    expect(await redis.hget(found[0]!, 'n')).toBe('9');

    expect((await store().login(customer.email)).statusCode).toBe(200);
    expect(await redis.keys(pattern)).toEqual([]);
    // Nine more wrong ones are the first nine again: the tenth overall would have locked without the reset.
    for (let i = 0; i < 9; i++) await store().login(customer.email, 'wrong-password');
    expect((await store().login(customer.email)).statusCode).toBe(200);
  });

  it('does not count a correct password on a suspended customer (a 403 is not a failure)', async () => {
    const suspended = await makeCustomer(t, { status: 'suspended' });
    for (let i = 0; i < 12; i++) expect((await store().login(suspended.email)).statusCode).toBe(403);
  });

  it('ends the session the request already carried, so a sign-in never continues an old session', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    await client.login(customer.email);
    const first = client.sessionToken!;
    await client.login(customer.email);
    expect(client.sessionToken).not.toBe(first);
    const sessions = await sessionsOf(customer.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[1]!.revokedAt).toBeNull();
  });

  it('answers 422 on the fields for a malformed body', async () => {
    const res = await store().call('POST', '/store/v1/auth/login', { email: '' });
    expect(res.statusCode).toBe(422);
    expect(
      problem(res)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['email', 'password']);
  });
});

describe('POST /store/v1/auth/magic-link and /auth/verify', () => {
  it('emails a link to a known account and signs it in once: verified, a full session, the link spent', async () => {
    const customer = await makeCustomer(t, { emailVerifiedAt: null });
    const client = store();
    const res = await client.magicLink(customer.email.toUpperCase());
    expect(res.statusCode).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    const [link] = customerLinks();
    expect(link).toMatchObject({ kind: 'magic_link', customerId: customer.id });

    const { db } = await testDb();
    // The outbox event carries ids only, never the token or the address.
    const [event] = await db.select().from(s.outboxEvents);
    expect(event).toMatchObject({ type: 'customer.magic_link', aggregateType: 'customers', aggregateId: customer.id });
    expect(JSON.stringify(event!.payload)).not.toContain(link!.token);
    expect(JSON.stringify(event!.payload)).not.toContain(customer.email);
    const [row] = await db.select().from(s.authTokens);
    expect(row).toMatchObject({ purpose: 'magic_link', subjectType: 'customer', subjectId: customer.id, usedAt: null });
    expect(row!.tokenHash).not.toBe(link!.token);
    expect(row!.expiresAt.toISOString()).toBe('2026-11-07T11:00:00.000Z');

    const verified = await client.verify(link!.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      id: customer.id,
      email: customer.email,
      emailVerifiedAt: '2026-11-07T10:00:00.000Z',
      hasPassword: true,
    });
    expect(verified.cookies.some((cookie) => cookie.name === SESSION_COOKIE_NAMES.customer)).toBe(true);
    expect((await client.me()).statusCode).toBe(200);
    expect((await customerRow(customer.id)).lastLoginAt).not.toBeNull();

    const again = await store().verify(link!.token);
    expect(again.statusCode).toBe(410);
    expect(problem(again).code).toBe('TOKEN_INVALID');
  });

  it('answers 204 for every email alike, and makes a customer of an email the store does not know (self-signup)', async () => {
    const known = await makeCustomer(t);
    const suspended = await makeCustomer(t, { status: 'suspended' });
    const answers = [
      await store().magicLink(known.email),
      await store().magicLink('brand.new@example.com'),
      await store().magicLink(suspended.email),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    }
    // A link only for the known account and the new one; the suspended customer gets nothing.
    expect(customerLinks().map((link) => link.kind)).toEqual(['magic_link', 'magic_link']);
    const { db } = await testDb();
    const [created] = await db.select().from(s.customers).where(eq(s.customers.email, 'brand.new@example.com'));
    expect(created).toMatchObject({
      name: '',
      hasAccount: false,
      status: 'active',
      createdBy: null,
      emailVerifiedAt: null,
      createdAt: new Date('2026-11-07T10:00:00.000Z'),
    });
    expect(customerLinks()[1]!.customerId).toBe(created!.id);
  });

  it('makes the self-signup an account when its link is used, and is safe against two requests for one new email', async () => {
    await Promise.all([store().magicLink('twin@example.com'), store().magicLink('twin@example.com')]);
    const { db } = await testDb();
    const rows = await db.select().from(s.customers).where(eq(s.customers.email, 'twin@example.com'));
    expect(rows).toHaveLength(1);
    // Newest link wins: the first one was voided.
    const [first, second] = customerLinks();
    expect((await store().verify(first!.token)).statusCode).toBe(410);
    const client = store();
    expect((await client.verify(second!.token)).statusCode).toBe(200);
    expect(await customerRow(rows[0]!.id)).toMatchObject({ hasAccount: true });
    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({ customerId: rows[0]!.id, passwordHash: null });
  });

  it('sends nothing for a blocklisted email and creates no customer', async () => {
    const { db } = await testDb();
    const hash = t.app.get(TokenService).hash('blocked@example.com');
    await db.insert(s.blocklistEntries).values({ kind: 'email', valueHash: hash, display: 'b***@example.com' });
    expect((await store().magicLink('Blocked@Example.com')).statusCode).toBe(204);
    expect(customerLinks()).toEqual([]);
    expect(await db.select().from(s.customers)).toHaveLength(0);
  });

  it('sends nothing for an email on a blocklisted domain either, and creates no customer', async () => {
    const { db } = await testDb();
    await insertBlock(t, db, 'domain', 'tempbox.example');
    expect((await store().magicLink('Anyone@TempBox.example')).statusCode).toBe(204);
    expect(customerLinks()).toEqual([]);
    expect(await db.select().from(s.customers)).toHaveLength(0);
    // A different domain still gets its link.
    expect((await store().magicLink('anyone@other.example')).statusCode).toBe(204);
    expect(customerLinks()).toHaveLength(1);
  });

  it('refuses a link that expired, was replaced, is of another kind, or belongs to a customer who is suspended since', async () => {
    const customer = await makeCustomer(t);
    await store().magicLink(customer.email);
    const [expired] = customerLinks();
    clock.advance(HOUR + 1000);
    expect((await store().verify(expired!.token)).statusCode).toBe(410);

    clock.advance(-HOUR);
    await store().magicLink(customer.email);
    const [, fresh] = customerLinks();
    const { db } = await testDb();
    await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customer.id));
    expect((await store().verify(fresh!.token)).statusCode).toBe(410);
    await db.update(s.customers).set({ status: 'active' }).where(eq(s.customers.id, customer.id));

    // A reset link is not a sign-in link.
    await store().forgot(customer.email);
    const reset = customerLinks().find((link) => link.kind === 'password_reset')!;
    expect((await store().verify(reset.token)).statusCode).toBe(410);
    // Nothing above opened a session or spent the fresh link.
    expect(await sessionsOf(customer.id)).toHaveLength(0);
    expect((await store().verify(fresh!.token)).statusCode).toBe(200);
  });

  it('lets only one of two parallel requests use a link', async () => {
    const customer = await makeCustomer(t);
    await store().magicLink(customer.email);
    const [link] = customerLinks();
    const results = await Promise.all([store().verify(link!.token), store().verify(link!.token)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 410]);
    expect(await sessionsOf(customer.id)).toHaveLength(1);
  });

  it('answers 410 for a token that is not a token at all, or missing', async () => {
    expect((await store().verify('short')).statusCode).toBe(410);
    expect((await store().verify('x'.repeat(40))).statusCode).toBe(410);
    // The link guard runs before validation: a missing token is as invalid as a wrong one.
    expect((await store().call('POST', '/store/v1/auth/verify', {})).statusCode).toBe(410);
  });

  it('counts requests per email and address: the sixth is 429', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await store(ip).magicLink('limit@example.com')).statusCode).toBe(204);
    const sixth = await store(ip).magicLink('limit@example.com');
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await store().magicLink('limit@example.com')).statusCode).toBe(204);
  });
});

describe('POST /store/v1/auth/password/forgot and /auth/password/set', () => {
  it('sends a reset link to an active account only, and answers 204 for everybody', async () => {
    const account = await makeCustomer(t);
    const guest = await makeCustomer(t, { guest: true });
    const suspended = await makeCustomer(t, { status: 'suspended' });
    for (const email of [account.email, guest.email, suspended.email, 'nobody@example.com']) {
      const res = await store().forgot(email);
      expect(res.statusCode).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(customerLinks()).toMatchObject([{ kind: 'password_reset', customerId: account.id }]);
    const { db } = await testDb();
    const events = await db.select().from(s.outboxEvents);
    expect(events.map((event) => event.type)).toEqual(['customer.password_reset']);
  });

  it('chooses a password with a reset link: spent, sessions ended, nobody signed in, the new password works', async () => {
    const customer = await makeCustomer(t, { emailVerifiedAt: null });
    const signedIn = store();
    await signedIn.login(customer.email);
    await store().forgot(customer.email);
    const [link] = customerLinks();

    const client = store();
    const res = await client.setPassword(link!.token, 'a-much-longer-passphrase');
    expect(res.statusCode).toBe(204);
    expect(res.cookies).toEqual([]);
    expect((await sessionsOf(customer.id)).every((session) => session.revokedAt !== null)).toBe(true);
    expect((await signedIn.me()).statusCode).toBe(401);
    // A reset link does not prove the address; only an invitation does.
    expect((await customerRow(customer.id)).emailVerifiedAt).toBeNull();

    expect((await store().login(customer.email)).statusCode).toBe(401);
    expect((await store().login(customer.email, 'a-much-longer-passphrase')).statusCode).toBe(200);
    expect((await store().setPassword(link!.token, 'another-long-passphrase')).statusCode).toBe(410);
  });

  it('clears the lock of the email when the owner chooses a password with a reset link', async () => {
    const customer = await makeCustomer(t);
    for (let i = 0; i < 10; i++) await store().login(customer.email, 'wrong-password');
    expect((await store().login(customer.email)).statusCode).toBe(429);
    await store().forgot(customer.email);
    const [link] = customerLinks();
    expect((await store().setPassword(link!.token, 'a-much-longer-passphrase')).statusCode).toBe(204);
    expect((await store().login(customer.email, 'a-much-longer-passphrase')).statusCode).toBe(200);
  });

  it('refuses a weak password without spending the link, and a link that expired or is of another kind', async () => {
    const customer = await makeCustomer(t);
    await store().forgot(customer.email);
    const [link] = customerLinks();
    const weak = await store().setPassword(link!.token, 'password123');
    expect(weak.statusCode).toBe(422);
    expect(problem(weak)).toMatchObject({ code: 'WEAK_PASSWORD', errors: [{ field: 'password' }] });
    expect((await store().setPassword(link!.token, 'a-much-longer-passphrase')).statusCode).toBe(204);

    await store().forgot(customer.email);
    const second = customerLinks().at(-1)!;
    clock.advance(HOUR + 1000);
    expect((await store().setPassword(second.token, 'yet-another-passphrase')).statusCode).toBe(410);

    await store().magicLink(customer.email);
    const magic = customerLinks().at(-1)!;
    expect((await store().setPassword(magic.token, 'yet-another-passphrase')).statusCode).toBe(410);
  });

  it('lets the newest of two reset links win, and refuses the link of a suspended customer', async () => {
    const customer = await makeCustomer(t);
    await store().forgot(customer.email);
    await store().forgot(customer.email);
    const [older, newer] = customerLinks();
    expect((await store().setPassword(older!.token, 'a-much-longer-passphrase')).statusCode).toBe(410);
    const { db } = await testDb();
    await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customer.id));
    expect((await store().setPassword(newer!.token, 'a-much-longer-passphrase')).statusCode).toBe(410);
  });

  it('lets only one of two parallel requests use the link', async () => {
    const customer = await makeCustomer(t);
    await store().forgot(customer.email);
    const [link] = customerLinks();
    const results = await Promise.all([
      store().setPassword(link!.token, 'a-much-longer-passphrase'),
      store().setPassword(link!.token, 'another-long-passphrase'),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 410]);
  });

  it('counts forgot requests per email and address: the sixth is 429', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await store(ip).forgot('limit@example.com')).statusCode).toBe(204);
    expect((await store(ip).forgot('limit@example.com')).statusCode).toBe(429);
  });
});

describe('POST /store/v1/me/password', () => {
  it('changes the password: the other devices end, this session stays, the old password stops working', async () => {
    const customer = await makeCustomer(t);
    const phone = store();
    const laptop = store();
    await phone.login(customer.email);
    await laptop.login(customer.email);

    const res = await laptop.changePassword(CUSTOMER_PASSWORD, 'a-much-longer-passphrase');
    expect(res.statusCode).toBe(204);
    expect((await laptop.me()).statusCode).toBe(200);
    expect((await phone.me()).statusCode).toBe(401);
    expect((await store().login(customer.email)).statusCode).toBe(401);
    expect((await store().login(customer.email, 'a-much-longer-passphrase')).statusCode).toBe(200);
  });

  it('answers a wrong current password with 422 on its field, never 401, and refuses weak or unchanged passwords', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    await client.login(customer.email);
    const wrong = await client.changePassword('not-the-password', 'a-much-longer-passphrase');
    expect(wrong.statusCode).toBe(422);
    expect(problem(wrong).errors?.map((e) => e.field)).toEqual(['currentPassword']);
    const weak = await client.changePassword(CUSTOMER_PASSWORD, 'password123');
    expect(problem(weak)).toMatchObject({ code: 'WEAK_PASSWORD', errors: [{ field: 'newPassword' }] });
    const same = await client.changePassword(CUSTOMER_PASSWORD, CUSTOMER_PASSWORD);
    expect(problem(same)).toMatchObject({ code: 'WEAK_PASSWORD', errors: [{ field: 'newPassword' }] });
    expect((await client.me()).statusCode).toBe(200);
  });

  it('turns a pending_password session into a full one with new cookies after the forced change', async () => {
    const customer = await makeCustomer(t, { mustChangePassword: true });
    const client = store();
    await client.login(customer.email);
    const before = client.sessionToken!;
    const res = await client.changePassword(CUSTOMER_PASSWORD, 'a-much-longer-passphrase');
    expect(res.statusCode).toBe(204);
    expect(client.sessionToken).not.toBe(before);
    expect((await client.me()).statusCode).toBe(200);
    const { db } = await testDb();
    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({ mustChangePassword: false });
    expect(credentials!.passwordChangedAt).not.toBeNull();
    // The old token is dead (rotated), the new login does not ask for a change again.
    expect((await store().login(customer.email, 'a-much-longer-passphrase')).json()).toEqual({ next: 'done' });
  });

  it('needs the CSRF token and counts tries per account: the sixth is 429', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    await client.login(customer.email);
    const noToken = await client.changePassword(CUSTOMER_PASSWORD, 'a-much-longer-passphrase', { csrf: false });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
    expect((await client.me()).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await client.changePassword('wrong-password', 'a-much-longer-passphrase');
    expect((await client.changePassword('wrong-password', 'a-much-longer-passphrase')).statusCode).toBe(429);
  });
});

describe('POST /store/v1/auth/logout', () => {
  it('ends the session and clears both cookies; a request without the CSRF token is refused and signs nobody out', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    await client.login(customer.email);
    const refused = await client.logout({ csrf: false });
    expect(refused.statusCode).toBe(403);
    expect((await client.me()).statusCode).toBe(200);

    const res = await client.logout();
    expect(res.statusCode).toBe(204);
    expect(res.cookies.map((cookie) => cookie.name).sort()).toEqual(
      [SESSION_COOKIE_NAMES.customer, CSRF_COOKIE_NAMES.customer].sort(),
    );
    expect((await sessionsOf(customer.id))[0]!.revokedAt).not.toBeNull();
    expect((await client.me({ cookies: false })).statusCode).toBe(401);
  });

  it('signs a customer out of every device when it was suspended meanwhile', async () => {
    const customer = await makeCustomer(t);
    const a = store();
    const b = store();
    await a.login(customer.email);
    await b.login(customer.email);
    const { db } = await testDb();
    await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customer.id));
    await clearIdentityCaches(t);
    // The guard answers 403 and ends every session of the suspended account.
    expect((await a.me()).statusCode).toBe(403);
    expect((await b.me()).statusCode).toBe(401);
  });

  it('keeps a customer out once an admin ended the sessions: the next call is 401', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    await client.login(customer.email);
    const { db } = await testDb();
    await db.update(s.sessions).set({ revokedAt: clock.now() });
    await clearIdentityCaches(t);
    expect((await client.me()).statusCode).toBe(401);
  });
});

describe('the anti-bot token on the three public auth routes (decision 034)', () => {
  /** The rows a refused call must leave alone. */
  const footprint = async () => {
    const { db } = await testDb();
    return {
      customers: (await db.select().from(s.customers)).length,
      sessions: (await db.select().from(s.sessions)).length,
      outbox: (await db.select().from(s.outboxEvents)).length,
      links: customerLinks().length,
    };
  };
  const refused = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('TURNSTILE_FAILED');
  };

  it('refuses POST /store/v1/auth/magic-link without the token (or with a wrong one) and creates no customer, link or event', async () => {
    const known = await makeCustomer(t);
    const before = await footprint();
    refused(await store().magicLink('brand.new@example.com', { turnstile: false }));
    refused(await store().magicLink(known.email, { turnstile: false }));
    refused(await store().magicLink(known.email, { turnstile: 'wrong-token' }));
    expect(await footprint()).toEqual(before);
  });

  it('refuses POST /store/v1/auth/login without the token before it looks at the password: no session, and no failure is counted', async () => {
    const customer = await makeCustomer(t);
    const client = store();
    refused(await client.login(customer.email, CUSTOMER_PASSWORD, { turnstile: false }));
    refused(await client.login(customer.email, CUSTOMER_PASSWORD, { turnstile: 'wrong-token' }));
    expect(client.sessionToken).toBeUndefined();
    expect(await sessionsOf(customer.id)).toHaveLength(0);
    expect((await customerRow(customer.id)).lastLoginAt).toBeNull();

    // Ten tokenless wrong passwords from other addresses lock nobody out: the refusal comes first.
    for (let i = 0; i < 10; i++) refused(await store().login(customer.email, 'wrong-password', { turnstile: false }));
    expect((await store().login(customer.email)).statusCode).toBe(200);
  });

  it('refuses POST /store/v1/auth/password/forgot without the token and sends no link or event', async () => {
    const account = await makeCustomer(t);
    const before = await footprint();
    refused(await store().forgot(account.email, { turnstile: false }));
    refused(await store().forgot(account.email, { turnstile: 'wrong-token' }));
    expect(await footprint()).toEqual(before);
    expect(customerLinks()).toEqual([]);
  });
});
