// Integration tests of POST /client/auth/verify-email: the emailed link proves the mailbox, and a full session of the same merchant in
// the same request proves the holder of the password chosen before the address was proven. Without that session the address is still verified, but
// that earlier password and the two-step sign-in enrolled with it stop working, every session of the merchant ends and the address
// gets a link to choose a password. Also the sign-in and the password change next to it: a proven password counts while it is stored.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { PasswordHasher } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { MERCHANT_MAIL_EVENTS, MerchantAuthTokens, SessionService } from '@src/modules/identity';
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
import { adminWith } from '../../support/admin-api';
import { freshClientIp } from '../../support/pipeline-routes';
import { codeFor } from '../../support/staff-console';
import { TURNSTILE_TEST_TOKEN, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
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
/** The shop's one password form (`POST /client/auth/sign-in`). */
const oneFormSignIn = (email: string, password: string) =>
  portal().call(
    'POST',
    '/client/auth/sign-in',
    { email, password },
    { csrf: false, headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } },
  );

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
  await t.app.get(DbService).runInTransaction(async (work) => {
    await t.app.get(MerchantAuthTokens).issue(work, { clientId: merchant.id, purpose: 'verify_email' });
  });
  const link = emailedLinks().find((l) => l.kind === 'email_verification');
  expect(link).toBeDefined();
  return link!;
}

/** The password links created for a merchant since the test started. */
const passwordLinksOf = (clientId: number) =>
  emailedLinks().filter((l) => l.kind === 'password_reset' && l.clientId === clientId);

/** The live (not revoked) sessions of a merchant. */
async function liveSessionsOf(clientId: number) {
  const { db } = await testDb();
  return db
    .select({ id: s.sessions.id })
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'client'), eq(s.sessions.subjectId, clientId), isNull(s.sessions.revokedAt)));
}

/** A point a request waits at until the test lets it go on. */
function gate() {
  let open!: () => void;
  let enter!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (enter = resolve));
  return { open, enter, opened, reached };
}

async function resetEventsOf(clientId: number) {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, MERCHANT_MAIL_EVENTS.password_reset));
  return rows.filter((row) => String(row.aggregateId) === String(clientId));
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
    const row = await clientRow(link.clientId);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBeNull();
    expect((await browser.me()).statusCode).toBe(200);
    expect((await portal().login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });
    expect(passwordLinksOf(link.clientId)).toEqual([]);
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
    const row = await clientRow(link.clientId);
    expect(row.status).toBe('active');
    expect(row.emailVerifiedAt?.getTime()).toBe(clock.nowMs());
    expect(row.passwordHash).toBeNull();

    // The session of the earlier browser ended, and the earlier password no longer signs in.
    expect((await holder.me()).statusCode).toBe(401);
    expect((await portal().login(email, EARLIER_PASSWORD)).statusCode).toBe(401);

    // The address gets the password link through the reset mail, and that link sets a password that signs in.
    const links = passwordLinksOf(link.clientId);
    expect(links).toHaveLength(1);
    expect(await resetEventsOf(link.clientId)).toHaveLength(1);
    clock.advance(60_000);
    expect((await portal().reset(links[0]!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    expect((await portal().login(email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('treats the session of another merchant as no session', async () => {
    const email = 'other-browser@example.com';
    const link = await unconfirmed(email);
    const other = await makeMerchant(t);
    const browser = portal();
    expect((await browser.login(other.email)).json()).toEqual({ next: 'done' });

    expect((await browser.verifyEmail(link.token)).statusCode).toBe(204);
    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
    expect(passwordLinksOf(link.clientId)).toHaveLength(1);
    // The other merchant is not touched.
    expect((await browser.me()).statusCode).toBe(200);
    expect((await clientRow(other.id)).passwordHash).not.toBeNull();
  });

  it('answers 403 CSRF_FAILED for a session of the merchant without its CSRF token and leaves the link usable', async () => {
    const email = 'no-header@example.com';
    const link = await unconfirmed(email);
    const browser = portal();
    expect((await browser.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    const refused = await browser.verifyEmail(link.token, { csrf: false });
    expect(refused.statusCode).toBe(403);
    expect(problem(refused).code).toBe('CSRF_FAILED');
    expect((await clientRow(link.clientId)).emailVerifiedAt).toBeNull();

    expect((await browser.verifyEmail(link.token)).statusCode).toBe(204);
    expect((await clientRow(link.clientId)).passwordHash).not.toBeNull();
  });

  it('on the address of a shop customer, a verification without a session keeps the customer sign-in and leaves the merchant without a password', async () => {
    const email = 'shop.owner@example.com';
    const customerPassword = 'owner-shop-password-1';
    await makeCustomer(t, { email, password: customerPassword });
    const oneForm = (password: string) =>
      portal().call(
        'POST',
        '/client/auth/sign-in',
        { email, password },
        { csrf: false, headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } },
      );

    const link = await unconfirmed(email);
    const holder = portal();
    expect((await holder.login(email, EARLIER_PASSWORD)).json()).toEqual({ next: 'done' });

    // The owner of the mailbox presses the button of the mail, in a browser without a merchant session.
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);

    // The shop sign-in of the owner still answers as the customer.
    const shop = await oneForm(customerPassword);
    expect(shop.statusCode).toBe(200);
    expect(shop.json()).toMatchObject({ kind: 'customer' });

    // The holder's session ended and its password is gone: no sign-in, no second factor to enrol.
    expect((await holder.setupTwoFactor()).statusCode).toBe(401);
    expect((await holder.login(email, EARLIER_PASSWORD)).statusCode).toBe(401);
    expect((await oneForm(EARLIER_PASSWORD)).statusCode).toBe(401);

    // Only the mailbox owner can choose the merchant password, and the sign-in then asks for no second step.
    const [setLink] = passwordLinksOf(link.clientId);
    expect(setLink).toBeDefined();
    clock.advance(60_000);
    expect((await portal().reset(setLink!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    expect((await portal().login(email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
    expect(await clientRow(link.clientId)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
  });

  it('after staff changed the address of a merchant with two-step sign-in, a verification without a session also ends that second factor', async () => {
    const email = 'new.address.owner@example.com';
    const customerPassword = 'owner-shop-password-2';
    await makeCustomer(t, { email, password: customerPassword });
    const holder = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z') });
    const staff = await adminWith(t, ['*'], { ip: '203.0.113.50' });
    expect((await staff.patch(`/admin/clients/${holder.id}`, { email })).status).toBe(200);
    const link = emailedLinks().find((l) => l.kind === 'email_verification' && l.clientId === holder.id);
    expect(link).toBeDefined();

    // The owner of the new address presses the button of the mail; the change ended every session of the merchant.
    expect((await portal().verifyEmail(link!.token)).statusCode).toBe(204);
    expect(await clientRow(holder.id)).toMatchObject({
      passwordHash: null,
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });
    const shop = await oneFormSignIn(email, customerPassword);
    expect(shop.statusCode).toBe(200);
    expect(shop.json()).toMatchObject({ kind: 'customer' });

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

    const merchantSignIn = await oneFormSignIn(email, CHOSEN_PASSWORD);
    expect(merchantSignIn.statusCode).toBe(200);
    expect(merchantSignIn.json()).toMatchObject({ kind: 'merchant' });
  });
});

describe('POST /client/auth/verify-email next to a password change or a sign-in of the same merchant at the same moment', () => {
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
    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
    expect((await portal().login(email, CHANGED_PASSWORD)).statusCode).toBe(401);
    expect(await liveSessionsOf(link.clientId)).toEqual([]);

    // The mailed link was not voided by the refused change: it still sets the password.
    const [setLink] = passwordLinksOf(link.clientId);
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
    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
    expect((await browser.me()).statusCode).toBe(401);
    expect((await portal().login(email, CHANGED_PASSWORD)).statusCode).toBe(401);
    expect(passwordLinksOf(link.clientId)).toHaveLength(1);
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
    expect(await liveSessionsOf(link.clientId)).toEqual([]);
    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
  });

  it('a sign-in that holds the row first opens its session, and the verification then ends it', async () => {
    const email = 'login-first@example.com';
    const link = await unconfirmed(email);
    const holder = portal();

    // The sign-in has locked the merchant row and waits before it inserts the session.
    const sessions = t.app.get(SessionService);
    const create = sessions.create.bind(sessions);
    const held = gate();
    spyOn(sessions, 'create').mockImplementation(async (input, work) => {
      if (input.subjectType === 'client') {
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
    expect(await liveSessionsOf(link.clientId)).toEqual([]);
    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
  });

  it('a hash upgrade after a sign-in writes nothing once the verification ended the password', async () => {
    const email = 'rehash@example.com';
    const link = await unconfirmed(email);
    const holder = portal();

    // The stored hash is due for an upgrade; the upgrade is hashing the proven password when the verification commits.
    const hasher = t.app.get(PasswordHasher);
    const hash = hasher.hash.bind(hasher);
    spyOn(hasher, 'needsRehash').mockReturnValue(true);
    const held = gate();
    spyOn(hasher, 'hash').mockImplementation(async (password: string) => {
      if (password === EARLIER_PASSWORD) {
        held.enter();
        await held.opened;
      }
      return hash(password);
    });
    const login = holder.login(email, EARLIER_PASSWORD);
    await held.reached;
    expect((await portal().verifyEmail(link.token)).statusCode).toBe(204);
    held.open();
    await login;

    expect((await clientRow(link.clientId)).passwordHash).toBeNull();
    expect((await holder.me()).statusCode).toBe(401);
    expect(await liveSessionsOf(link.clientId)).toEqual([]);
    expect((await portal().login(email, EARLIER_PASSWORD)).statusCode).toBe(401);
  });

  it('counts a session that is still at the code step as no session', async () => {
    const merchant = await makeMerchant(t, { status: 'pending', twofa: true, emailVerifiedAt: null });
    const browser = portal();
    expect((await browser.login(merchant.email)).json()).toEqual({ next: 'totp' });
    const issued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(MerchantAuthTokens).issue(work, { clientId: merchant.id, purpose: 'verify_email' }),
      );

    expect((await browser.verifyEmail(issued.token)).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({
      passwordHash: null,
      twofaEnabled: false,
      totpSecretEnc: null,
    });
    expect(passwordLinksOf(merchant.id)).toHaveLength(1);
    expect((await browser.code(await codeFor(merchant.secret, clock.nowMs()))).statusCode).toBe(401);
  });
});

describe('a sign-in opens its session only while the stored hash holds the password it proved', () => {
  /** Holds the first password check of the test until the gate opens. */
  function holdFirstCheck() {
    const hasher = t.app.get(PasswordHasher);
    const verifyHash = hasher.verify.bind(hasher);
    const held = gate();
    let checks = 0;
    spyOn(hasher, 'verify').mockImplementation(async (hashed: string, password: string) => {
      const correct = await verifyHash(hashed, password);
      checks += 1;
      if (checks === 1) {
        held.enter();
        await held.opened;
      }
      return correct;
    });
    return held;
  }

  it('two sign-ins at the same moment while the hash is due for an upgrade both open a session', async () => {
    const merchant = await makeMerchant(t);
    spyOn(t.app.get(PasswordHasher), 'needsRehash').mockReturnValue(true);
    const held = holdFirstCheck();
    const first = portal();
    const login = first.login(merchant.email);
    await held.reached;

    // Another sign-in completes meanwhile and upgrades the hash the held one was checked against.
    const before = (await clientRow(merchant.id)).passwordHash;
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'done' });
    expect((await clientRow(merchant.id)).passwordHash).not.toBe(before);
    held.open();

    expect((await login).json()).toEqual({ next: 'done' });
    expect((await first.me()).statusCode).toBe(200);
    expect(await liveSessionsOf(merchant.id)).toHaveLength(2);
  });

  it('refuses a sign-in whose password was replaced by another one after its check (401), and opens no session', async () => {
    const merchant = await makeMerchant(t);
    const held = holdFirstCheck();
    const browser = portal();
    const login = browser.login(merchant.email);
    await held.reached;

    // The owner of the mailbox sets another password through a reset link while the sign-in is held.
    expect((await portal().forgot(merchant.email)).statusCode).toBe(204);
    const [resetLink] = passwordLinksOf(merchant.id);
    expect(resetLink).toBeDefined();
    expect((await portal().reset(resetLink!.token, CHOSEN_PASSWORD)).statusCode).toBe(204);
    held.open();

    const res = await login;
    expect(res.statusCode).toBe(401);
    expect(problem(res).code).toBe('UNAUTHORIZED');
    expect(await liveSessionsOf(merchant.id)).toEqual([]);
    expect((await portal().login(merchant.email, CHOSEN_PASSWORD)).json()).toEqual({ next: 'done' });
  });
});

describe('two-step sign-in is enrolled only on a merchant that holds a password', () => {
  it('refuses setup and enable with 401 once the password is gone, and turns nothing on', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const browser = portal();
    expect((await browser.login(merchant.email)).json()).toEqual({ next: 'done' });
    const setup = await browser.setupTwoFactor();
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json<{ secret: string }>();

    const { db } = await testDb();
    await db.update(s.clients).set({ passwordHash: null }).where(eq(s.clients.id, merchant.id));

    const enabled = await browser.enableTwoFactor(await codeFor(secret, clock.nowMs()));
    expect(enabled.statusCode).toBe(401);
    expect(problem(enabled).code).toBe('UNAUTHORIZED');
    expect((await browser.setupTwoFactor()).statusCode).toBe(401);
    expect(await clientRow(merchant.id)).toMatchObject({ twofaEnabled: false });
  });
});
