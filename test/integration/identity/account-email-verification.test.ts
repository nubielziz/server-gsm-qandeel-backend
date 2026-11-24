// Integration tests of POST /client/auth/verify-email and its resend for every account (decision 064, MISMATCHES B123): the emailed link proves
// the mailbox, and a full session of the same account in the same request proves the holder of the password chosen before the address was
// proven. Without that session the address is still verified, but that earlier password and the two-step sign-in enrolled with it stop
// working, every session of the account ends and the address gets a link to choose a password. An account without a password only gets
// its address stamped. An account that may not act, of any rank, gets one 410. Also the sign-in and the password change next to it: a
// proven password counts while it is stored. Replaces merchant-verify-email.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { and, eq, isNull, like } from 'drizzle-orm';
import { PasswordHasher } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { AccountAuthTokens, SessionService } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../../support/identity-mail';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  emailedLinks,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientIp } from '../../support/pipeline-routes';
import { codeFor } from '../../support/staff-console';
import { openAccountSession } from '../../support/account-sessions';
import {
  CUSTOMER_PASSWORD,
  STORE_ORIGIN,
  TURNSTILE_TEST_TOKEN,
  clearStoreRateLimits,
  makeCustomer,
} from '../../support/store';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` }, clock });
});
afterEach(() => {
  mock.restore();
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
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  captureEmailedLinks(t);
});

const EARLIER_PASSWORD = 'earlier-pass-91';
const CHOSEN_PASSWORD = 'quiet-harbour-dawn-42';
const portal = () => new MerchantPortal(t, freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; detail?: string };
/** The one password form (`POST /client/auth/sign-in`): it serves every rank, and a retail account calls it from the shop. */
const oneFormSignIn = (browser: MerchantPortal, email: string, password: string, origin: string = PORTAL_ORIGIN) =>
  browser.call(
    'POST',
    '/client/auth/sign-in',
    { email, password },
    {
      csrf: false,
      origin,
      headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN },
    },
  );

/** Issues a verification link to an account, as staff changing the address or the account asking again would. */
async function sendVerification(accountId: number) {
  await t.app.get(DbService).runInTransaction(async (work) => {
    await t.app.get(AccountAuthTokens).issue(work, { accountId, purpose: 'verify_email' });
  });
  const link = emailedLinks().find((l) => l.kind === 'email_verification' && l.accountId === accountId);
  expect(link).toBeDefined();
  return link!;
}

/**
 * Makes a merchant that has a password and an address nobody proved yet (staff set a temporary password and the merchant replaced it),
 * and returns the verification link it was sent.
 */
async function unconfirmed(email: string) {
  const merchant = await makeMerchant(t, {
    email,
    name: 'Ali Hassan',
    emailVerifiedAt: null,
    password: EARLIER_PASSWORD,
  });
  return sendVerification(merchant.id);
}

/** The password links created for an account since the test started. */
const passwordLinksOf = (accountId: number) =>
  emailedLinks().filter((l) => l.kind === 'password_reset' && l.accountId === accountId);

/** The live (not revoked) sessions of an account. */
async function liveSessionsOf(accountId: number) {
  const { db } = await testDb();
  return db
    .select({ id: s.sessions.id })
    .from(s.sessions)
    .where(
      and(eq(s.sessions.subjectType, 'account'), eq(s.sessions.subjectId, accountId), isNull(s.sessions.revokedAt)),
    );
}

/** The outbox events of the password-reset mail of an account (the merchant and the retail family differ in name only). */
async function resetEventsOf(accountId: number) {
  const { db } = await testDb();
  const rows = await db.select().from(s.outboxEvents).where(like(s.outboxEvents.type, '%.password_reset'));
  return rows.filter((row) => String(row.aggregateId) === String(accountId));
}

/** The links of the link table that are still usable for an account. */
async function openLinksOf(accountId: number) {
  const { db } = await testDb();
  return db
    .select({ id: s.authTokens.id, purpose: s.authTokens.purpose })
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectId, accountId), isNull(s.authTokens.usedAt)));
}

/** A point a request waits at until the test lets it go on. */
function gate() {
  let open!: () => void;
  let enter!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (enter = resolve));
  return { open, enter, opened, reached };
}

describe('POST /client/auth/verify-email: the address and the password holder prove the account together', () => {
  it('with a full session of the same merchant it verifies the address and keeps the password and the session', async () => {
    const email = 'holder@example.com';
    const link = await unconfirmed(email);
    const browser = portal();
    expect((await browser.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    const res = await browser.verifyEmail(link.token);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const row = await clientRow(link.accountId);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBeNull();
    expect((await browser.me()).statusCode).toBe(200);
    expect((await portal().login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });
    expect(passwordLinksOf(link.accountId)).toEqual([]);
  });

  it('without a session it verifies the address, ends the earlier password and every session, and mails a password link', async () => {
    const email = 'mailbox@example.com';
    const link = await unconfirmed(email);
    const holder = portal();
    expect((await holder.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    const res = await portal().verifyEmail(link.token);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    const row = await clientRow(link.accountId);
    expect(row.status).toBe('active');
    expect(row.emailVerifiedAt?.getTime()).toBe(clock.nowMs());
    expect(row.passwordHash).toBeNull();

    // The session of the earlier browser ended, and the earlier password no longer signs in.
    expect((await holder.me()).statusCode).toBe(401);
    expect((await portal().login(email, EARLIER_PASSWORD)).statusCode).toBe(401);

    // The address gets the password link through the reset mail, and that link sets a password that signs in.
    const links = passwordLinksOf(link.accountId);
    expect(links).toHaveLength(1);
    expect(await resetEventsOf(link.accountId)).toHaveLength(1);
    clock.advance(60_000);
    expect((await portal().reset(links[0]!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    expect((await portal().login(email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('treats the session of another account as no session', async () => {
    const email = 'other-browser@example.com';
    const link = await unconfirmed(email);
    const other = await makeMerchant(t);
    const browser = portal();
    expect((await browser.login(other.email)).json()).toEqual({ next: 'done' });

    expect((await browser.verifyEmail(link.token)).statusCode).toBe(204);
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
    expect(passwordLinksOf(link.accountId)).toHaveLength(1);
    // The other account is not touched.
    expect((await browser.me()).statusCode).toBe(200);
    expect((await clientRow(other.id)).passwordHash).not.toBeNull();
  });

  it('answers 403 CSRF_FAILED for a session of the account without its CSRF token and leaves the link usable', async () => {
    const email = 'no-header@example.com';
    const link = await unconfirmed(email);
    const browser = portal();
    expect((await browser.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    const refused = await browser.verifyEmail(link.token, { csrf: false });
    expect(refused.statusCode).toBe(403);
    expect(problem(refused).code).toBe('CSRF_FAILED');
    expect((await clientRow(link.accountId)).emailVerifiedAt).toBeNull();
    expect(await openLinksOf(link.accountId)).toHaveLength(1);

    expect((await browser.verifyEmail(link.token)).statusCode).toBe(204);
    expect((await clientRow(link.accountId)).passwordHash).not.toBeNull();
  });

  it('on an address that a guest row also holds, it touches the login row only', async () => {
    const email = 'shared.address@example.com';
    const guest = await makeCustomer(t, { email, guest: true });
    const link = await unconfirmed(email);

    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
    // The guest row has no login: nothing of it changes, and it gets no password link.
    expect(await clientRow(guest.id)).toMatchObject({ hasAccount: false, emailVerifiedAt: null, passwordHash: null });
    expect(passwordLinksOf(guest.id)).toEqual([]);
    expect(passwordLinksOf(link.accountId)).toHaveLength(1);
  });

  it('after staff changed the address of a merchant with two-step sign-in, a verification without a session also ends that second factor', async () => {
    const email = 'new.address.owner@example.com';
    const holder = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z') });
    const { db } = await testDb();
    // Staff changed the address: the address is unproven again and the link of the change is out.
    await db.update(s.clients).set({ email, emailVerifiedAt: null }).where(eq(s.clients.id, holder.id));
    const link = await sendVerification(holder.id);

    // The owner of the new address presses the button of the mail, in a browser without a session.
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    expect(await clientRow(holder.id)).toMatchObject({
      passwordHash: null,
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });

    // The mailed link sets the password, and the sign-in with it asks for no second step.
    const [setLink] = passwordLinksOf(holder.id);
    expect(setLink).toBeDefined();
    clock.advance(60_000);
    expect((await portal().reset(setLink!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    const owner = portal();
    expect((await owner.login(email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await owner.me()).statusCode).toBe(200);
    // The previous holder's authenticator completes nothing.
    expect((await owner.code(await codeFor(holder.secret, clock.nowMs()))).statusCode).toBe(401);
    expect(await clientRow(holder.id)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
  });
});

describe('POST /client/auth/verify-email for a retail account', () => {
  it('with the full session of the account and its CSRF token it only stamps the address, and the session stays', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null, password: EARLIER_PASSWORD });
    const link = await sendVerification(buyer.id);
    const browser = portal();
    const signedIn = await oneFormSignIn(browser, buyer.email, EARLIER_PASSWORD, STORE_ORIGIN);
    expect(signedIn.statusCode).toBe(200);

    const res = await browser.call(
      'POST',
      '/client/auth/verify-email',
      { token: link.token },
      { origin: STORE_ORIGIN },
    );
    expect(res.statusCode).toBe(204);
    expect(await clientRow(buyer.id)).toMatchObject({ emailVerifiedAt: new Date(clock.nowMs()) });
    expect((await clientRow(buyer.id)).passwordHash).not.toBeNull();
    expect(await liveSessionsOf(buyer.id)).toHaveLength(1);
    expect(passwordLinksOf(buyer.id)).toEqual([]);
  });

  it('without a session it ends the password, the sessions and the second factor of the account and mails a retail password link', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null, password: EARLIER_PASSWORD });
    const link = await sendVerification(buyer.id);
    const holder = portal();
    expect((await oneFormSignIn(holder, buyer.email, EARLIER_PASSWORD, STORE_ORIGIN)).statusCode).toBe(200);

    const res = await portal().call(
      'POST',
      '/client/auth/verify-email',
      { token: link.token },
      { origin: STORE_ORIGIN },
    );
    expect(res.statusCode).toBe(204);
    expect(await clientRow(buyer.id)).toMatchObject({ passwordHash: null, twofaEnabled: false });
    expect(await liveSessionsOf(buyer.id)).toEqual([]);
    expect((await oneFormSignIn(portal(), buyer.email, EARLIER_PASSWORD, STORE_ORIGIN)).statusCode).toBe(401);
    expect(passwordLinksOf(buyer.id)).toHaveLength(1);
    expect(await resetEventsOf(buyer.id)).toHaveLength(1);
  });

  it('only stamps an account that has no password (it signs in by link), keeps its session and mails nothing', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null, noPassword: true });
    await openAccountSession(t, buyer.id);
    const link = await sendVerification(buyer.id);
    expect(await liveSessionsOf(buyer.id)).toHaveLength(1);

    // No session on the request: with no password there is no holder to prove, so nothing ends.
    const res = await portal().call(
      'POST',
      '/client/auth/verify-email',
      { token: link.token },
      { origin: STORE_ORIGIN },
    );
    expect(res.statusCode).toBe(204);
    expect((await clientRow(buyer.id)).emailVerifiedAt).not.toBeNull();
    expect(await liveSessionsOf(buyer.id)).toHaveLength(1);
    expect(passwordLinksOf(buyer.id)).toEqual([]);
    expect(await resetEventsOf(buyer.id)).toEqual([]);
  });

  it('never signs in: the answer is empty and sets no cookie', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null, noPassword: true });
    const link = await sendVerification(buyer.id);
    const res = await portal().call(
      'POST',
      '/client/auth/verify-email',
      { token: link.token },
      { origin: STORE_ORIGIN },
    );
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    expect(await liveSessionsOf(buyer.id)).toEqual([]);
  });
});

describe('POST /client/auth/verify-email for an account that may not act', () => {
  it.each(['suspended', 'blocked', 'anonymized'] as const)(
    'answers 410 TOKEN_INVALID for a %s account of either rank and changes nothing',
    async (status) => {
      // an anonymized row carries the time it was anonymized (clients_anonymized_check)
      const state = status === 'anonymized' ? { status, anonymizedAt: new Date(clock.nowMs()) } : { status };
      const merchant = await makeMerchant(t, { emailVerifiedAt: null, ...state });
      const buyer = await makeCustomer(t, { emailVerifiedAt: null, ...state });
      for (const account of [merchant, buyer]) {
        const link = await sendVerification(account.id);
        const res = await portal().verifyEmail(link.token);
        expect(res.statusCode).toBe(410);
        expect(problem(res).code).toBe('TOKEN_INVALID');
        const row = await clientRow(account.id);
        expect(row.emailVerifiedAt).toBeNull();
        expect(row.passwordHash).not.toBeNull();
      }
    },
  );

  it('answers the same 410 for an unknown, used or foreign link', async () => {
    const buyer = await makeCustomer(t, { emailVerifiedAt: null });
    const link = await sendVerification(buyer.id);
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(410);
    expect((await portal().verifyEmail('unknown-token-unknown-token-unknown')).statusCode).toBe(410);
    // a sign-in link is not a verification link
    const issued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(AccountAuthTokens).issue(work, { accountId: buyer.id, purpose: 'magic_link' }),
      );
    expect((await portal().verifyEmail(issued.token)).statusCode).toBe(410);
  });

  it('refuses a guest row: a mailed link cannot make a login out of it', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const link = await sendVerification(guest.id);
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(410);
    expect((await clientRow(guest.id)).emailVerifiedAt).toBeNull();
  });
});

describe('POST /client/auth/verify-email/resend', () => {
  it('mails a signed-in merchant a new verification link, the newest link replaces the older one, and a retail account is refused', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const buyer = await makeCustomer(t, { emailVerifiedAt: null, password: CUSTOMER_PASSWORD });
    const merchantBrowser = portal();
    expect((await merchantBrowser.login(merchant.email)).json()).toEqual({ next: 'done' });
    const buyerBrowser = portal();
    expect((await oneFormSignIn(buyerBrowser, buyer.email, CUSTOMER_PASSWORD, STORE_ORIGIN)).statusCode).toBe(200);

    expect((await merchantBrowser.resendVerification()).statusCode).toBe(204);
    // The route serves merchant ranks only (decision 064): the shop has no resend button.
    const refused = await buyerBrowser.resendVerification({ origin: STORE_ORIGIN });
    expect(refused.statusCode).toBe(403);
    expect(problem(refused).code).toBe('RANK_NOT_ALLOWED');
    const kinds = emailedLinks().filter((l) => l.kind === 'email_verification');
    expect(kinds.map((l) => l.accountId)).toEqual([merchant.id]);
    expect(await openLinksOf(merchant.id)).toHaveLength(1);
    expect(await openLinksOf(buyer.id)).toEqual([]);

    clock.advance(60_000);
    expect((await merchantBrowser.resendVerification()).statusCode).toBe(204);
    // the newest link replaced the older one
    expect(await openLinksOf(merchant.id)).toHaveLength(1);
  });

  it('answers 409 CONFLICT for an address that is already verified', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const browser = portal();
    expect((await browser.login(merchant.email)).json()).toEqual({ next: 'done' });
    const res = await browser.resendVerification();
    expect(res.statusCode).toBe(409);
    expect(problem(res)).toMatchObject({ code: 'CONFLICT', detail: 'This email address is already verified.' });
    expect(emailedLinks()).toEqual([]);
  });

  it('answers 401 without a session', async () => {
    expect((await portal().resendVerification()).statusCode).toBe(401);
  });
});

describe('POST /client/auth/verify-email next to a password change or a sign-in of the same account at the same moment', () => {
  const CHANGED_PASSWORD = 'changed-pass-word-77';

  it('refuses a password change whose current password was checked before the verification committed (401), and stores no password', async () => {
    const email = 'change-before@example.com';
    const link = await unconfirmed(email);
    const browser = portal();
    expect((await browser.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    // The change has checked the current password and is hashing the new one when the verification commits.
    const hasher = t.app.get(PasswordHasher);
    const hash = hasher.hash.bind(hasher);
    const held = gate();
    spyOn(hasher, 'hash').mockImplementation(async (password: string) => {
      if (password === CHANGED_PASSWORD) {
        held.enter();
        await held.opened;
      }
      return hash(password);
    });
    const change = browser.changePassword(EARLIER_PASSWORD, CHANGED_PASSWORD);
    await held.reached;
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    held.open();

    const changed = await change;
    expect(changed.statusCode).toBe(401);
    expect(problem(changed)).toMatchObject({
      code: 'UNAUTHORIZED',
      detail: 'The account changed while this request ran. Sign in again.',
    });
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
    expect((await portal().login(email, CHANGED_PASSWORD)).statusCode).toBe(401);
    expect(await liveSessionsOf(link.accountId)).toEqual([]);

    // The mailed link was not voided by the refused change: it still sets the password.
    const [setLink] = passwordLinksOf(link.accountId);
    expect(setLink).toBeDefined();
    clock.advance(60_000);
    expect((await portal().reset(setLink!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    expect((await portal().login(email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('a password change that holds the row first commits, and the verification then ends the new password and every session', async () => {
    const email = 'change-first@example.com';
    const link = await unconfirmed(email);
    const browser = portal();
    expect((await browser.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    // The change has written the new password (the row is locked) and waits before it ends the other sessions.
    const sessions = t.app.get(SessionService);
    const revokeAllOf = sessions.revokeAllOf.bind(sessions);
    const held = gate();
    spyOn(sessions, 'revokeAllOf').mockImplementation(async (subjectType, subjectId, options = {}, work) => {
      if (options.exceptSessionId !== undefined) {
        held.enter();
        await held.opened;
      }
      return revokeAllOf(subjectType, subjectId, options, work);
    });
    const change = browser.changePassword(EARLIER_PASSWORD, CHANGED_PASSWORD);
    await held.reached;
    const verify = portal().verifyEmail(link.token);
    await Bun.sleep(300);
    held.open();

    expect((await change).statusCode).toBe(204);
    expect((await verify).statusCode).toBe(204);
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
    expect((await browser.me()).statusCode).toBe(401);
    expect((await portal().login(email, CHANGED_PASSWORD)).statusCode).toBe(401);
    expect(passwordLinksOf(link.accountId)).toHaveLength(1);
  });

  it('refuses a sign-in whose password was checked before the verification committed (401), and opens no session', async () => {
    const email = 'login-before@example.com';
    const link = await unconfirmed(email);
    const holder = portal();

    // The sign-in has checked the password and has not opened its session yet when the verification commits.
    const hasher = t.app.get(PasswordHasher);
    const verifyHash = hasher.verify.bind(hasher);
    const held = gate();
    spyOn(hasher, 'verify').mockImplementation(async (hashed: string, password: string) => {
      const correct = await verifyHash(hashed, password);
      if (password === EARLIER_PASSWORD) {
        held.enter();
        await held.opened;
      }
      return correct;
    });
    const login = holder.login(email, EARLIER_PASSWORD);
    await held.reached;
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    held.open();

    const res = await login;
    expect(res.statusCode).toBe(401);
    expect(problem(res).code).toBe('UNAUTHORIZED');
    expect((await holder.me()).statusCode).toBe(401);
    expect(await liveSessionsOf(link.accountId)).toEqual([]);
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
  });

  it('a sign-in that holds the row first opens its session, and the verification then ends it', async () => {
    const email = 'login-first@example.com';
    const link = await unconfirmed(email);
    const holder = portal();

    // The sign-in has locked the account row and waits before it inserts the session.
    const sessions = t.app.get(SessionService);
    const create = sessions.create.bind(sessions);
    const held = gate();
    spyOn(sessions, 'create').mockImplementation(async (input, work) => {
      if (input.subjectType === 'account') {
        held.enter();
        await held.opened;
      }
      return create(input, work);
    });
    const login = holder.login(email, EARLIER_PASSWORD);
    await held.reached;
    const verify = portal().verifyEmail(link.token);
    await Bun.sleep(300);
    held.open();

    expect((await login).json()).toEqual({ next: 'done' });
    expect((await verify).statusCode).toBe(204);
    expect((await holder.me()).statusCode).toBe(401);
    expect(await liveSessionsOf(link.accountId)).toEqual([]);
    expect((await clientRow(link.accountId)).passwordHash).toBeNull();
  });

  it('counts a session that is still at the code step as no session', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: null });
    const browser = portal();
    expect((await browser.login(merchant.email)).json()).toEqual({ next: 'totp' });
    const link = await sendVerification(merchant.id);

    expect((await browser.verifyEmail(link.token)).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({
      passwordHash: null,
      twofaEnabled: false,
      totpSecretEnc: null,
    });
    expect(passwordLinksOf(merchant.id)).toHaveLength(1);
    expect((await browser.code(await codeFor(merchant.secret, clock.nowMs()))).statusCode).toBe(401);
  });
});
