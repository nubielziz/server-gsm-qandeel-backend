// Integration tests of the merchant sign-in's second look at the account: a session is opened only if the account is still as it was when
// the password was checked (the same password, the same two-step and forced-change state, a status that may sign in), and a due
// hash upgrade is written only under that same check. A password check is held open to place a reset by link, or a switch-on of two-step
// sign-in, between the check and the session.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { PasswordHasher } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../../support/identity-mail';
import {
  MERCHANT_PASSWORD,
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
import { STORE_ORIGIN, TURNSTILE_TEST_TOKEN, clearStoreRateLimits } from '../../support/store';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: { CORS_ORIGINS: PORTAL_ORIGIN, SHOP_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` },
    clock,
  });
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

const NEW_PASSWORD = 'owner-new-secret-phrase-77';
const WRONG_DETAIL = 'The email or password is not correct.';

/** Holds the first password check after it ran, until the test lets it go. */
function holdFirstPasswordCheck() {
  const hasher = t.app.get(PasswordHasher);
  const original = hasher.verify.bind(hasher);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const checked = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  spyOn(hasher, 'verify').mockImplementation(async (hash: string, password: string) => {
    const result = await original(hash, password);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return result;
  });
  return { release, checked };
}

const liveSessions = async (clientId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'client'), eq(s.sessions.subjectId, clientId), isNull(s.sessions.revokedAt)));
};

/** Mails a reset link to the merchant and returns its token. */
async function mailedResetToken(email: string): Promise<string> {
  expect((await new MerchantPortal(t, freshClientIp()).forgot(email)).statusCode).toBe(204);
  return emailedLinks().findLast((l) => l.kind === 'password_reset')!.token;
}

const oneFormSignIn = (portal: MerchantPortal, email: string, password: string) =>
  portal.call(
    'POST',
    '/client/auth/sign-in',
    { email, password },
    { csrf: false, headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } },
  );

describe('a merchant sign-in is decided on the account as it is when the session opens', () => {
  it('refuses a sign-in whose password was checked before a reset by link committed, and leaves no session', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const token = await mailedResetToken(merchant.email);
    const late = new MerchantPortal(t, freshClientIp());

    const { release, checked } = holdFirstPasswordCheck();
    const pending = late.login(merchant.email, MERCHANT_PASSWORD);
    await checked;
    mock.restore();
    expect((await new MerchantPortal(t, freshClientIp()).reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    release();
    const login = await pending;

    expect(login.statusCode).toBe(401);
    expect(login.json<{ detail: string }>().detail).toBe(WRONG_DETAIL);
    expect(await liveSessions(merchant.id)).toEqual([]);
    expect((await late.me()).statusCode).toBe(401);
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email, NEW_PASSWORD)).json()).toEqual({
      next: 'done',
    });
  });

  it('refuses a sign-in that was under way when two-step sign-in was switched on', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const owner = new MerchantPortal(t, freshClientIp());
    expect((await owner.login(merchant.email)).json()).toEqual({ next: 'done' });
    const secret = (await owner.setupTwoFactor()).json<{ secret: string }>().secret;

    const late = new MerchantPortal(t, freshClientIp());
    const { release, checked } = holdFirstPasswordCheck();
    const pending = late.login(merchant.email, MERCHANT_PASSWORD);
    await checked;
    mock.restore();
    expect((await owner.enableTwoFactor(await codeFor(secret, clock.nowMs()))).statusCode).toBe(204);
    release();
    const login = await pending;

    expect(login.statusCode).toBe(401);
    expect((await late.me()).statusCode).toBe(401);
    // The owner's own session is the only one left, and a new sign-in now asks for the code.
    expect((await liveSessions(merchant.id)).map((row) => row.stage)).toEqual(['active']);
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email)).json()).toEqual({ next: 'totp' });
  });

  it('refuses the one-form sign-in the same way after a reset by link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const token = await mailedResetToken(merchant.email);
    const late = new MerchantPortal(t, freshClientIp());

    const { release, checked } = holdFirstPasswordCheck();
    const pending = oneFormSignIn(late, merchant.email, MERCHANT_PASSWORD);
    await checked;
    mock.restore();
    expect((await new MerchantPortal(t, freshClientIp()).reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    release();
    const answer = await pending;

    expect(answer.statusCode).toBe(401);
    expect(await liveSessions(merchant.id)).toEqual([]);
  });
});

describe('the hash upgrade of a merchant sign-in', () => {
  it('does not write over the password a reset chose while the sign-in was under way', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const token = await mailedResetToken(merchant.email);
    const late = new MerchantPortal(t, freshClientIp());

    const hasher = t.app.get(PasswordHasher);
    const due = spyOn(hasher, 'needsRehash').mockImplementation(() => true);
    const { release, checked } = holdFirstPasswordCheck();
    const pending = late.login(merchant.email, MERCHANT_PASSWORD);
    await checked;
    expect((await new MerchantPortal(t, freshClientIp()).reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    const chosen = (await clientRow(merchant.id)).passwordHash;
    release();
    expect((await pending).statusCode).toBe(401);
    due.mockRestore();
    mock.restore();

    expect((await clientRow(merchant.id)).passwordHash).toBe(chosen);
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(
      401,
    );
  });

  it('lets a sign-in through whose hash another sign-in of the same merchant upgraded meanwhile', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const hasher = t.app.get(PasswordHasher);
    const due = spyOn(hasher, 'needsRehash').mockImplementation(() => true);
    const slow = new MerchantPortal(t, freshClientIp());
    const { release, checked } = holdFirstPasswordCheck();
    const pending = slow.login(merchant.email, MERCHANT_PASSWORD);
    await checked;
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({
      next: 'done',
    });
    const upgraded = (await clientRow(merchant.id)).passwordHash;
    expect(upgraded).not.toBe(merchant.row.passwordHash);
    release();
    const late = await pending;
    due.mockRestore();
    mock.restore();

    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ next: 'done' });
    expect((await slow.me()).statusCode).toBe(200);
    // The later upgrade is written only over the hash it verified: the first one stays.
    expect((await clientRow(merchant.id)).passwordHash).toBe(upgraded);
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(
      200,
    );
  });

  it('is still written when the account did not change, on both sign-in routes', async () => {
    const hasher = t.app.get(PasswordHasher);
    for (const route of ['login', 'sign-in'] as const) {
      const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
      const before = (await clientRow(merchant.id)).passwordHash;
      const due = spyOn(hasher, 'needsRehash').mockImplementation(() => true);
      const portal = new MerchantPortal(t, freshClientIp());
      const answer =
        route === 'login'
          ? await portal.login(merchant.email, MERCHANT_PASSWORD)
          : await oneFormSignIn(portal, merchant.email, MERCHANT_PASSWORD);
      due.mockRestore();
      expect(answer.statusCode, route).toBe(200);
      const after = (await clientRow(merchant.id)).passwordHash;
      expect(after, route).not.toBe(before);
      expect(await hasher.verify(after!, MERCHANT_PASSWORD), route).toBe(true);
      expect((await portal.me()).statusCode, route).toBe(200);
    }
  });
});
