// Integration tests of the emailed sign-in link of the retail rank (decision 064; routes POST /store/v1/auth/magic-link and /verify) through
// HTTP on the real application: who gets a link (and, since decision 079, who the note with the sign-up page instead), that every email is
// answered alike, a guest row that a link mailed before decision 079 turns into an account, the browser that asked for the link, two-step
// sign-in, a rank or status that changed after the mail, the email that gained a login row after the mail, and the verification link that
// the deployed shop page still posts here during the expand release. Replaces store-link-browser.test.ts and the link half of
// store-sign-in.test.ts; the sign-up itself is test/integration/customers/store-sign-up.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { CLIENT_TOTP_AAD, TotpService } from '@src/modules/identity/application/totp.service';
import { AccountAuthTokens } from '@src/modules/identity';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { ACCOUNT_SESSION_COOKIE, LEGACY_STORE_SESSION_COOKIE, csrfCookieNameOf } from '../../support/account-sessions';
import { accountRow, ensureMerchantGroup, ensureRetailGroup } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { freshClientIp } from '../../support/pipeline-routes';
import { makeMerchant } from '../../support/merchant-portal';
import { insertBlock } from '../../support/risk';
import { codeFor } from '../../support/staff-console';
import { seedIdentityTemplates, clearAccountMailLimits } from '../../support/identity-mail';
import {
  STORE_ORIGIN,
  StoreClient,
  clearStoreRateLimits,
  issueOldSignInLink,
  makeAccount,
  makeCustomer,
  noAccountNotes,
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
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  // The one retail rank, which a migration inserts and the reset empties: every guest row a request makes belongs to it.
  await ensureRetailGroup((await testDb()).db);
  captureAccountLinks(t);
});
afterEach(() => mock.restore());

const store = (ip?: string) => new StoreClient(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; detail?: string };
/** The sessions of an account (a staff session can carry the same subject id). */
const sessionsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'account'), eq(s.sessions.subjectId, accountId)))
    .orderBy(asc(s.sessions.id));
};
const linkRowsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, accountId)).orderBy(asc(s.authTokens.id));
};
const linkOf = (accountId: number, kind = 'magic_link') =>
  accountLinks().find((link) => link.kind === kind && link.accountId === accountId)!;
/** A guest row of the email with a sign-in link mailed to it before decision 079 (since then a link no longer makes an account). */
const guestWithOldLink = async (email: string) => {
  const guest = await makeCustomer(t, { guest: true, email, emailVerifiedAt: null });
  await issueOldSignInLink(t, guest.id);
};
const guestRowsOf = async (email: string) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.clients)
    .where(and(eq(s.clients.email, email), eq(s.clients.hasAccount, false)));
};
const allRows = async () => {
  const { db } = await testDb();
  return db.select({ id: s.clients.id }).from(s.clients);
};

describe('POST /store/v1/auth/magic-link: who gets a link', () => {
  it('emails a link to a retail account and answers 204 with no store caching', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null });
    const res = await store().magicLink(buyer.email.toUpperCase());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(accountLinks()).toHaveLength(1);
    const link = linkOf(buyer.id);
    expect(link).toBeDefined();

    const { db } = await testDb();
    // The outbox event carries ids only, never the token or the address.
    const [event] = await db.select().from(s.outboxEvents);
    expect(event).toMatchObject({ type: 'customer.magic_link', aggregateId: buyer.id });
    expect(JSON.stringify(event!.payload)).not.toContain(link.token);
    expect(JSON.stringify(event!.payload)).not.toContain(buyer.email);
    const [row] = await db.select().from(s.authTokens);
    expect(row).toMatchObject({ purpose: 'magic_link', subjectType: 'account', subjectId: buyer.id, usedAt: null });
    expect(row!.tokenHash).not.toBe(link.token);
    expect(row!.expiresAt.toISOString()).toBe('2026-11-07T11:00:00.000Z');
  });

  it('answers every email alike, and mails the note to an email nobody holds, making no row (decision 079: no link)', async () => {
    const known = await makeCustomer(t);
    const rowsBefore = await allRows();
    const answers = [await store().magicLink(known.email), await store().magicLink('brand.new@example.com')];
    for (const res of answers) {
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    }
    expect(accountLinks().map((link) => link.accountId)).toEqual([known.id]);
    // The note goes to the typed address: a stranger cannot plant guest rows for any address (the review of decision 079).
    expect(await guestRowsOf('brand.new@example.com')).toEqual([]);
    expect(await allRows()).toHaveLength(rowsBefore.length);
    expect(await noAccountNotes()).toEqual(['brand.new@example.com']);
  });

  it('answers two requests for one new email alike: a note for each, no row and no link', async () => {
    await Promise.all([store().magicLink('twin@example.com'), store().magicLink('twin@example.com')]);
    expect(await guestRowsOf('twin@example.com')).toEqual([]);
    expect(await noAccountNotes()).toEqual(['twin@example.com', 'twin@example.com']);
    expect(accountLinks()).toEqual([]);
  });

  it('keeps the links of a guest row mailed before decision 079 working: one after the other, each spending the rest', async () => {
    await guestWithOldLink('twin@example.com');
    const [guest] = await guestRowsOf('twin@example.com');
    await issueOldSignInLink(t, guest!.id);
    // A link the visitor asked for does not void the one sent before (decision 052): the first still works, and using it spends the other.
    const [first, second] = accountLinks();
    expect((await store().verify(first!.token)).statusCode).toBe(200);
    expect((await store().verify(second!.token)).statusCode).toBe(410);
    expect(await accountRow(guest!.id)).toMatchObject({ hasAccount: true });
  });

  it.each([
    ['a suspended account', { status: 'suspended' as const }],
    ['a blocked account', { status: 'blocked' as const }],
    ['an anonymized account', { status: 'anonymized' as const, anonymizedAt: new Date('2026-11-01T00:00:00.000Z') }],
  ])('sends nothing to %s, answers 204 and keeps nothing', async (_name, overrides) => {
    const holder = await makeCustomer(t, overrides);
    const rowsBefore = await allRows();
    const before = (await linkRowsOf(holder.id)).length;
    expect((await store().magicLink(holder.email)).statusCode).toBe(204);
    expect(accountLinks()).toEqual([]);
    expect(await linkRowsOf(holder.id)).toHaveLength(before);
    expect(await allRows()).toHaveLength(rowsBefore.length);
  });

  it('sends nothing to the email of a merchant rank, makes no guest row for it and answers 204', async () => {
    const merchant = await makeMerchant(t);
    const rowsBefore = await allRows();
    expect((await store().magicLink(merchant.email)).statusCode).toBe(204);
    expect(accountLinks()).toEqual([]);
    expect(await allRows()).toHaveLength(rowsBefore.length);
    expect(await guestRowsOf(merchant.email)).toEqual([]);
    expect(await linkRowsOf(merchant.id)).toEqual([]);
  });

  it('sends nothing for a blocklisted email and creates no guest row; a blocklisted domain gets nothing either', async () => {
    const { db } = await testDb();
    const hash = t.app.get(TokenService).hash('blocked@example.com');
    await db.insert(s.blocklistEntries).values({ kind: 'email', valueHash: hash, display: 'b***@example.com' });
    expect((await store().magicLink('Blocked@Example.com')).statusCode).toBe(204);
    await insertBlock(t, db, 'domain', 'tempbox.example');
    expect((await store().magicLink('Anyone@TempBox.example')).statusCode).toBe(204);
    expect(accountLinks()).toEqual([]);
    expect(await allRows()).toHaveLength(0);
    // A different domain still gets its mail: the note, since no account uses the address (decision 079).
    expect((await store().magicLink('anyone@other.example')).statusCode).toBe(204);
    expect(accountLinks()).toEqual([]);
    expect(await noAccountNotes()).toHaveLength(1);
  });

  it('sends nothing to a blocked guest row, and a login row hides the guest row that shares its email', async () => {
    const { db } = await testDb();
    const blockedGuest = await makeCustomer(t, { guest: true, status: 'blocked' });
    expect((await store().magicLink(blockedGuest.email)).statusCode).toBe(204);
    expect(accountLinks()).toEqual([]);

    // A login row and a guest row with one email: the link goes to the login row.
    const login = await makeCustomer(t);
    await db.insert(s.clients).values({
      email: login.email.toUpperCase(),
      name: '',
      groupId: login.row.groupId,
      hasAccount: false,
      status: 'active',
      referralCode: 'REF-GUEST-SHARED',
    });
    expect((await store().magicLink(login.email)).statusCode).toBe(204);
    expect(accountLinks().map((link) => link.accountId)).toEqual([login.id]);
  });

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

  it('counts requests per email and address: the sixth is 429, and a refusal of the anti-bot token comes first', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect((await store(ip).magicLink('limit@example.com')).statusCode).toBe(204);
    const sixth = await store(ip).magicLink('limit@example.com');
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await store().magicLink('limit@example.com')).statusCode).toBe(204);

    const known = await makeCustomer(t);
    const before = (await allRows()).length;
    for (const turnstile of [false, 'wrong-token'] as const) {
      const refused = await store().magicLink(known.email, { turnstile });
      expect(refused.statusCode).toBe(403);
      expect(problem(refused).code).toBe('TURNSTILE_FAILED');
    }
    expect((await allRows()).length).toBe(before);
  });

  it('sends at most five links an hour to one account, and still answers 204', async () => {
    const buyer = await makeCustomer(t);
    for (let i = 0; i < 7; i++) expect((await store().magicLink(buyer.email)).statusCode).toBe(204);
    expect(accountLinks().filter((link) => link.accountId === buyer.id)).toHaveLength(5);
    // Up to three links work at once: the oldest are replaced.
    const open = (await linkRowsOf(buyer.id)).filter((row) => row.usedAt === null);
    expect(open.length).toBeLessThanOrEqual(3);
  });
});

describe('POST /store/v1/auth/verify: the exchange', () => {
  it('signs the account in once: verified, a full session, the link spent, the cookies of its rank, and the old shop cookie cleared', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null });
    const browser = store();
    await browser.magicLink(buyer.email);
    const link = linkOf(buyer.id);

    const verified = await browser.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      id: buyer.id,
      email: buyer.email,
      requestedHere: true,
      maskedEmail: 'cu•••@example.com',
      next: 'done',
      claimedOrders: 0,
    });
    expect(verified.json<{ claimSkipped?: string }>().claimSkipped).toBeUndefined();
    const cookieNames = verified.cookies.map((cookie) => cookie.name);
    expect(cookieNames).toContain(ACCOUNT_SESSION_COOKIE);
    expect(cookieNames).toContain(csrfCookieNameOf('retail'));
    // the cookie of the old shop session is cleared on every sign-in
    expect(verified.cookies.find((cookie) => cookie.name === LEGACY_STORE_SESSION_COOKIE)?.maxAge).toBe(0);
    expect((await browser.me()).statusCode).toBe(200);
    const row = await accountRow(buyer.id);
    expect(row.emailVerifiedAt).toEqual(new Date('2026-11-07T10:00:00.000Z'));
    expect(row.lastLoginAt).not.toBeNull();
    expect((await sessionsOf(buyer.id))[0]).toMatchObject({ subjectType: 'account', stage: 'active', revokedAt: null });

    const again = await store().verify(link.token);
    expect(again.statusCode).toBe(410);
    expect(problem(again).code).toBe('TOKEN_INVALID');
  });

  it('makes an account of a guest row: has_account true, the mailbox proven, a session, and nothing else about the row changes', async () => {
    await guestWithOldLink('newcomer@example.com');
    const [guest] = await guestRowsOf('newcomer@example.com');
    const browser = store();
    const verified = await browser.verify(linkOf(guest!.id).token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: guest!.id, email: 'newcomer@example.com', claimedOrders: 0 });
    expect(await accountRow(guest!.id)).toMatchObject({
      hasAccount: true,
      emailVerifiedAt: new Date('2026-11-07T10:00:00.000Z'),
      passwordHash: null,
      status: 'active',
      groupId: guest!.groupId,
    });
    expect((await browser.me()).statusCode).toBe(200);
  });

  it('voids the other sign-in links of the account when one is used', async () => {
    const buyer = await makeCustomer(t);
    await store().magicLink(buyer.email);
    await store().magicLink(buyer.email);
    const [first, second] = accountLinks();
    expect((await store().verify(first!.token)).statusCode).toBe(200);
    expect((await store().verify(second!.token)).statusCode).toBe(410);
    expect((await linkRowsOf(buyer.id)).every((row) => row.usedAt !== null)).toBe(true);
  });

  it('asks for the code step when two-step sign-in is on: a pending_totp session, finished by POST /client/auth/2fa', async () => {
    const totp = t.app.get(TotpService);
    const secret = totp.newSecret();
    const buyer = await makeCustomer(t, { twofaEnabled: true, totpSecretEnc: totp.seal(secret, CLIENT_TOTP_AAD) });
    const browser = store();
    await browser.magicLink(buyer.email);

    const verified = await browser.verify(linkOf(buyer.id).token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: buyer.id, next: 'totp' });
    expect((await sessionsOf(buyer.id))[0]).toMatchObject({ stage: 'pending_totp' });
    expect((await browser.me()).statusCode).toBe(401);

    const code = await browser.call('POST', '/client/auth/2fa', { code: await codeFor(secret, clock.nowMs()) });
    expect(code.statusCode).toBe(204);
    expect((await browser.me()).statusCode).toBe(200);
  });

  it('refuses a link that expired, was replaced, is of another kind, or belongs to an account that is suspended or a merchant rank since', async () => {
    const buyer = await makeCustomer(t);
    await store().magicLink(buyer.email);
    const [expired] = accountLinks();
    clock.advance(HOUR + 1000);
    expect((await store().verify(expired!.token)).statusCode).toBe(410);

    clock.advance(-HOUR);
    await store().magicLink(buyer.email);
    const fresh = accountLinks()[1]!;
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, buyer.id));
    expect((await store().verify(fresh.token)).statusCode).toBe(410);
    await db.update(s.clients).set({ status: 'active' }).where(eq(s.clients.id, buyer.id));

    // A rank raised to a merchant rank after the mail ends the link.
    const merchantGroup = await ensureMerchantGroup(db);
    await db.update(s.clients).set({ groupId: merchantGroup }).where(eq(s.clients.id, buyer.id));
    expect((await store().verify(fresh.token)).statusCode).toBe(410);
    await db.update(s.clients).set({ groupId: buyer.row.groupId }).where(eq(s.clients.id, buyer.id));

    // A reset link is not a sign-in link.
    await t.app.get(DbService).runInTransaction(async (work) => {
      await t.app.get(AccountAuthTokens).issue(work, { accountId: buyer.id, purpose: 'reset' });
    });
    const reset = accountLinks().find((link) => link.kind === 'password_reset')!;
    expect((await store().verify(reset.token)).statusCode).toBe(410);
    // Nothing above opened a session or spent the fresh link.
    expect(await sessionsOf(buyer.id)).toHaveLength(0);
    expect((await store().verify(fresh.token)).statusCode).toBe(200);
  });

  it('lets only one of two parallel requests use a link', async () => {
    const buyer = await makeCustomer(t);
    const browser = store();
    await browser.magicLink(buyer.email);
    const link = linkOf(buyer.id);
    const results = await Promise.all([browser.verify(link.token), browser.verify(link.token)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 410]);
    expect(await sessionsOf(buyer.id)).toHaveLength(1);
  });

  it('answers 410 for a token that is not a token at all, or missing', async () => {
    expect((await store().verify('short')).statusCode).toBe(410);
    expect((await store().verify('x'.repeat(40))).statusCode).toBe(410);
    // The link guard runs before validation: a missing token is as invalid as a wrong one.
    expect((await store().call('POST', '/store/v1/auth/verify', {})).statusCode).toBe(410);
  });

  it('refuses the exchange from a website that is not the shop, and the link still works from the shop', async () => {
    const buyer = await makeCustomer(t);
    await store().magicLink(buyer.email);
    const link = linkOf(buyer.id);
    const spent = async () => (await linkRowsOf(buyer.id))[0]?.usedAt;

    const browser = store();
    const foreign = await browser.verify(link.token, { headers: { origin: 'https://evil.example' } });
    expect(foreign.statusCode).toBe(403);
    expect(problem(foreign).code).toBe('CSRF_FAILED');
    expect(foreign.cookies).toEqual([]);
    expect(await spent()).toBeNull();

    const bare = await t.app.inject({ method: 'POST', url: '/store/v1/auth/verify', payload: { token: link.token } });
    expect(bare.statusCode).toBe(403);
    expect(await spent()).toBeNull();
    expect(await sessionsOf(buyer.id)).toHaveLength(0);

    const fromShop = await browser.verify(link.token);
    expect(fromShop.statusCode).toBe(200);
    expect(await spent()).not.toBeNull();
  });
});

describe('POST /store/v1/auth/verify: the browser that asked for the link', () => {
  it('signs the browser that asked in and says so; a second link asked there works there too', async () => {
    const buyer = await makeCustomer(t);
    const browser = store();
    await browser.magicLink(buyer.email);
    const first = browser.cookie(LINK_COOKIE);
    await browser.magicLink(buyer.email);
    expect(browser.cookie(LINK_COOKIE)).toBe(first);
    const [earlier] = accountLinks();

    const verified = await browser.verify(earlier!.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: buyer.id, email: buyer.email, requestedHere: true });
    expect(verified.json<{ maskedEmail: string }>().maskedEmail).toBe('cu•••@example.com');
    expect((await browser.me()).json<{ id: number }>().id).toBe(buyer.id);
  });

  it('refuses a link asked for elsewhere while the browser holds another account session: that session lives, the link stays usable', async () => {
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
    expect(refused.cookies.map((cookie) => cookie.name)).not.toContain(ACCOUNT_SESSION_COOKIE);

    // The holder's session is untouched and still answers as the holder; the link was not spent and opened no session.
    expect(holderBrowser.sessionToken).toBe(holderSession);
    const [session] = await sessionsOf(holder.id);
    expect(session!.revokedAt).toBeNull();
    expect((await holderBrowser.me()).json<{ id: number }>().id).toBe(holder.id);
    expect((await linkRowsOf(owner.id))[0]!.usedAt).toBeNull();
    expect(await sessionsOf(owner.id)).toHaveLength(0);

    expect((await ownerBrowser.verify(link.token)).statusCode).toBe(200);
    expect((await ownerBrowser.me()).json<{ id: number }>().id).toBe(owner.id);
  });

  it('signs a browser with no session in and says the link was asked for elsewhere, with the masked address', async () => {
    const buyer = await makeCustomer(t);
    await store().magicLink(buyer.email);
    const link = linkOf(buyer.id);

    const elsewhere = store();
    const verified = await elsewhere.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: buyer.id, requestedHere: false, maskedEmail: 'cu•••@example.com' });
    expect((await elsewhere.me()).json<{ id: number }>().id).toBe(buyer.id);
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

  it("signs in as before when the browser holds the link account's own session, and ends the old session", async () => {
    const buyer = await makeCustomer(t);
    const browser = store();
    await browser.login(buyer.email);
    await store().magicLink(buyer.email);
    const link = linkOf(buyer.id);

    const verified = await browser.verify(link.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: buyer.id, requestedHere: false });
    // A new sign-in never continues the old session.
    const sessions = await sessionsOf(buyer.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[1]!.revokedAt).toBeNull();
  });
});

describe('the email that gained a login row after the mail', () => {
  it('staff creating a merchant with the email of a guest row voids the open links of the guest row', async () => {
    const email = 'guest.then.merchant@example.com';
    await guestWithOldLink(email);
    const [guest] = await guestRowsOf(email);
    const link = linkOf(guest!.id);
    const { db } = await testDb();
    const groupId = await ensureMerchantGroup(db);
    // The merchant's wallet is in USD, which the reset emptied.
    await insertUsd(db);
    const owner = await adminWith(t, ['*'], { name: 'Rami K.', ip: '203.0.113.50' });

    const created = await owner.post('/admin/clients', {
      name: 'Zain Hub',
      email,
      country: 'JO',
      invite: true,
      groupId,
    });
    expect(created.status).toBe(201);
    // The guest row stays; the link mailed to it can no longer turn it into a second login row.
    expect(await accountRow(guest!.id)).toMatchObject({ hasAccount: false });
    expect((await linkRowsOf(guest!.id)).every((row) => row.usedAt !== null)).toBe(true);
    const refused = await store().verify(link.token);
    expect(refused.statusCode).toBe(410);
    expect(problem(refused).code).toBe('TOKEN_INVALID');
    expect(await sessionsOf(guest!.id)).toHaveLength(0);
  });

  it('an exchange that meets clients_login_email_uq answers 410 and changes nothing', async () => {
    const email = 'late.login@example.com';
    await guestWithOldLink(email);
    const [guest] = await guestRowsOf(email);
    const link = linkOf(guest!.id);
    // A login row of the same email appears without voiding the link (a write that predates the rule, or a restore).
    await makeAccount(t, { rank: 'retail', email: 'LATE.LOGIN@example.com' });

    const refused = await store().verify(link.token);
    expect(refused.statusCode).toBe(410);
    expect(problem(refused).code).toBe('TOKEN_INVALID');
    expect(await accountRow(guest!.id)).toMatchObject({ hasAccount: false, emailVerifiedAt: null });
    // The link is not spent, no session opened, and no other link was voided.
    const { db } = await testDb();
    const open = await db
      .select({ id: s.authTokens.id })
      .from(s.authTokens)
      .where(and(eq(s.authTokens.subjectId, guest!.id), isNull(s.authTokens.usedAt)));
    expect(open).toHaveLength(1);
    expect(await sessionsOf(guest!.id)).toHaveLength(0);
  });
});

describe('the verification link on /store/v1/auth/verify', () => {
  /** Issues a verification link to an account, as staff changing the address would. */
  async function verificationLinkOf(accountId: number) {
    await t.app.get(DbService).runInTransaction(async (work) => {
      await t.app.get(AccountAuthTokens).issue(work, { accountId, purpose: 'verify_email' });
    });
    return accountLinks().find((link) => link.kind === 'email_verification' && link.accountId === accountId)!;
  }

  it('never opens a session (decision 052): 410 for a retail account with a password, nothing stamped and the link not spent', async () => {
    // The verification link sent after a staff email change: the earlier holder may still know the password, so only the verification
    // route, which voids that password without the holder's session, may use it.
    const buyer = await makeCustomer(t, { emailVerifiedAt: null });
    const link = await verificationLinkOf(buyer.id);
    const browser = store();
    const res = await browser.verify(link.token);
    expect(res.statusCode).toBe(410);
    expect(problem(res).code).toBe('TOKEN_INVALID');
    expect((await accountRow(buyer.id)).emailVerifiedAt).toBeNull();
    expect((await linkRowsOf(buyer.id)).every((row) => row.usedAt === null)).toBe(true);
    expect(await sessionsOf(buyer.id)).toHaveLength(0);
    expect((await browser.me()).statusCode).toBe(401);
  });

  it('answers 410 for a merchant rank and for a guest row, and spends nothing', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const guest = await makeCustomer(t, { guest: true });
    for (const account of [merchant, guest]) {
      const link = await verificationLinkOf(account.id);
      const res = await store().verify(link.token);
      expect(res.statusCode).toBe(410);
      expect(problem(res).code).toBe('TOKEN_INVALID');
      expect((await linkRowsOf(account.id))[0]!.usedAt).toBeNull();
      expect(await sessionsOf(account.id)).toHaveLength(0);
    }
  });
});
