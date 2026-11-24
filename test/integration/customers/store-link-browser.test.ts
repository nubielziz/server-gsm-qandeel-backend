// Integration tests of the storefront sign-in link and the browser that asked for it (POST /store/v1/auth/magic-link and
// /verify): the browser that asked signs in as before; a browser that holds another customer's session is refused and keeps that
// session; a browser with no session signs in and is told whose account the link opened.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { SESSION_COOKIE_NAMES } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  makeCustomer,
} from '../../support/store';

/** The cookie that marks the browser which asked for a sign-in link (not secure in tests, so without the `__Host-` prefix). */
const LINK_COOKIE = 'gsm_store_link';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: STORE_ORIGIN } });
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
const problem = (res: { json: () => unknown }) => res.json() as { code: string; detail?: string };
const sessionsOf = async (customerId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, customerId)).orderBy(asc(s.sessions.id));
};
const linkRowsOf = async (customerId: number) => {
  const { db } = await testDb();
  return db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, customerId)).orderBy(asc(s.authTokens.id));
};
const linkOf = (customerId: number) =>
  customerLinks().find((link) => link.kind === 'magic_link' && link.customerId === customerId)!;

describe('the sign-in link and the browser that asked for it', () => {
  it('marks the asking browser with a cookie that lives as long as the link, for every email alike', async () => {
    const known = await makeCustomer(t);
    const suspended = await makeCustomer(t, { status: 'suspended' });
    for (const email of [known.email, 'brand.new@example.com', suspended.email]) {
      const res = await store().magicLink(email);
      expect(res.statusCode).toBe(204);
      const cookie = res.cookies.find((c) => c.name === LINK_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 3600 });
      expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    // Only the keyed hash of the cookie is stored, with the link.
    const browser = store();
    await browser.magicLink(known.email);
    const [, row] = await linkRowsOf(known.id);
    expect(row!.browserHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.browserHash).not.toBe(browser.cookie(LINK_COOKIE));
  });

  it('signs the browser that asked in as before and says so; a second link asked there works there too', async () => {
    const customer = await makeCustomer(t);
    const browser = store();
    await browser.magicLink(customer.email);
    const first = browser.cookie(LINK_COOKIE);
    await browser.magicLink(customer.email);
    expect(browser.cookie(LINK_COOKIE)).toBe(first);
    const [earlier] = customerLinks();

    const verified = await browser.verify(earlier!.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: customer.id, email: customer.email, requestedHere: true });
    expect(verified.json<{ maskedEmail: string }>().maskedEmail).toBe('cu•••@example.com');
    expect(verified.cookies.map((cookie) => cookie.name)).toContain(SESSION_COOKIE_NAMES.account);
    expect((await browser.me()).json<{ id: number }>().id).toBe(customer.id);
  });

  it('refuses a link asked for elsewhere while the browser holds another customer session: that session lives, the link stays usable', async () => {
    const holder = await makeCustomer(t, { name: 'Browser Holder' });
    const owner = await makeCustomer(t, { name: 'Link Owner' });
    const holderBrowser = store();
    expect((await holderBrowser.login(holder.email)).statusCode).toBe(200);
    const holderSession = holderBrowser.sessionToken!;
    // The holder's browser asked for a link of its own earlier: its cookie does not match a link asked for in another browser.
    await holderBrowser.magicLink(holder.email);

    const ownerBrowser = store();
    await ownerBrowser.magicLink(owner.email);
    const link = linkOf(owner.id);

    const refused = await holderBrowser.verify(link.token);
    expect(refused.statusCode).toBe(409);
    expect(problem(refused)).toMatchObject({
      code: 'CONFLICT',
      detail: 'This browser is signed in to another account. Sign out first, then open the link again.',
    });
    expect(refused.cookies.map((cookie) => cookie.name)).not.toContain(SESSION_COOKIE_NAMES.account);

    // The holder's session is untouched and still answers as the holder; the link was not spent and opened no session.
    expect(holderBrowser.sessionToken).toBe(holderSession);
    const [session] = await sessionsOf(holder.id);
    expect(session!.revokedAt).toBeNull();
    expect((await holderBrowser.me()).json<{ id: number }>().id).toBe(holder.id);
    expect((await linkRowsOf(owner.id))[0]!.usedAt).toBeNull();
    expect(await sessionsOf(owner.id)).toHaveLength(0);

    // The holder's own details stay where they are: a change made in this browser lands in the holder's account.
    expect((await holderBrowser.updateMe({ phone: '+44 7700 900777' })).statusCode).toBe(200);
    expect((await holderBrowser.me()).json<{ phone: string }>().phone).toBe('+44 7700 900777');
    expect((await ownerBrowser.verify(link.token)).statusCode).toBe(200);
    const ownerMe = (await ownerBrowser.me()).json<{ id: number; phone: string }>();
    expect(ownerMe.id).toBe(owner.id);
    expect(ownerMe.phone).not.toBe('+44 7700 900777');
  });

  it('signs a browser with no session in and says the link was asked for elsewhere, with the masked address', async () => {
    const customer = await makeCustomer(t);
    await store().magicLink(customer.email);
    const link = linkOf(customer.id);

    const elsewhere = store();
    const verified = await elsewhere.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: customer.id, requestedHere: false, maskedEmail: 'cu•••@example.com' });
    expect((await elsewhere.me()).json<{ id: number }>().id).toBe(customer.id);
  });

  it('treats the kept cookie of an ended session as no session', async () => {
    const holder = await makeCustomer(t);
    const owner = await makeCustomer(t);
    const holderBrowser = store();
    await holderBrowser.login(holder.email);
    const ended = holderBrowser.sessionToken!;
    expect((await holderBrowser.logout()).statusCode).toBe(204);
    await store().magicLink(owner.email);
    const link = linkOf(owner.id);

    holderBrowser.setSessionToken(ended);
    const verified = await holderBrowser.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: owner.id, requestedHere: false });
  });

  it("signs in as before when the browser holds the link customer's own session", async () => {
    const customer = await makeCustomer(t);
    const browser = store();
    await browser.login(customer.email);
    await store().magicLink(customer.email);
    const link = linkOf(customer.id);

    const verified = await browser.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: customer.id, requestedHere: false });
    // A new sign-in never continues the old session.
    const sessions = await sessionsOf(customer.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[1]!.revokedAt).toBeNull();
  });

  it('lets only one of two parallel requests of the asking browser use the link', async () => {
    const customer = await makeCustomer(t);
    const browser = store();
    await browser.magicLink(customer.email);
    const link = linkOf(customer.id);
    const results = await Promise.all([browser.verify(link.token), browser.verify(link.token)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 410]);
    expect(await sessionsOf(customer.id)).toHaveLength(1);
  });
});
