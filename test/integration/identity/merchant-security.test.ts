// Integration tests of the merchant portal's password links and security settings (feature 2b, routes POST
// /client/auth/password/forgot and /reset, POST /client/security/password and /2fa/*; MISMATCHES B127 and B128, B131 to B134)
// through HTTP on the real application, and of the retired per-device session list.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq, isNull } from 'drizzle-orm';
import { schema as s, DbService } from '@src/infra/db';
import { CLIENT_TOTP_AAD, MerchantAuthTokens } from '@src/modules/identity';
import { EncryptionService } from '@src/infra/crypto';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';
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

const clock = new TestClock();
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
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  logSink.clear();
  captureEmailedLinks(t);
  await seedPortalBasics();
});

const NEW_PASSWORD = 'a-brand-new-password';
const portal = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
const codeNow = (secret: string, steps = 0): Promise<string> => codeFor(secret, clock.nowMs() + steps * 30 * SECOND);
const sessionsOf = async (clientId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, clientId)).orderBy(asc(s.sessions.id));
};
const liveSessionsOf = async (clientId: number) => (await sessionsOf(clientId)).filter((row) => row.revokedAt === null);
const outboxTypes = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.outboxEvents).orderBy(asc(s.outboxEvents.id))).map((row) => row.type);
};
/** Signs the merchant in on a new "device" and returns the portal that holds the session. */
async function signedIn(email: string, password = MERCHANT_PASSWORD): Promise<MerchantPortal> {
  const p = portal();
  const res = await p.login(email, password);
  expect(res.statusCode).toBe(200);
  return p;
}

describe('POST /client/auth/password/forgot', () => {
  it('answers 204 for any email and sends a link only for a merchant that is not suspended', async () => {
    const known = await makeMerchant(t);
    const suspended = await makeMerchant(t, { status: 'suspended' });
    const answers = [
      await portal().forgot(known.email.toUpperCase()),
      await portal().forgot('nobody@example.com'),
      await portal().forgot(suspended.email),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    }
    expect(await outboxTypes()).toEqual(['merchant.password_reset']);
    const { db } = await testDb();
    const [link] = await db.select().from(s.authTokens);
    expect(link).toMatchObject({ purpose: 'reset', subjectType: 'client', subjectId: known.id, usedAt: null });
    expect(link!.expiresAt.getTime()).toBe(clock.nowMs() + HOUR);
    expect(emailedLinks()).toMatchObject([{ kind: 'password_reset', clientId: known.id }]);
  });

  it('works for a merchant waiting for approval that has no password yet (an expired invitation)', async () => {
    const invited = await makeMerchant(t, { status: 'pending', noPassword: true });
    expect((await portal().forgot(invited.email)).statusCode).toBe(204);
    const [link] = emailedLinks();
    expect(link).toMatchObject({ kind: 'password_reset', clientId: invited.id });
    expect((await portal().reset(link!.token, NEW_PASSWORD)).statusCode).toBe(204);
    const p = portal();
    expect((await p.login(invited.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect(await clientRow(invited.id)).toMatchObject({ status: 'pending' });
  });

  it('keeps earlier links working (at most three), and counts requests per email and network', async () => {
    const merchant = await makeMerchant(t);
    const ip = freshClientIp();
    await portal(ip).forgot(merchant.email);
    await portal(ip).forgot(merchant.email);
    const [older, newer] = emailedLinks();
    // A second request does not void the first link (decision 052); using one spends the other.
    expect((await portal().reset(older!.token, NEW_PASSWORD)).statusCode).toBe(204);
    expect((await portal().reset(newer!.token, 'another-brand-new-password')).statusCode).toBe(410);

    for (let i = 0; i < 3; i++) expect((await portal(ip).forgot(merchant.email)).statusCode).toBe(204);
    const sixth = await portal(ip).forgot(merchant.email);
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // The unknown email is counted the same way, so the 429 tells nothing.
    for (let i = 0; i < 5; i++) await portal(ip).forgot('nobody@example.com');
    expect((await portal(ip).forgot('nobody@example.com')).statusCode).toBe(429);
  });

  it('answers 422 on email and refuses a request that does not come from the portal', async () => {
    const bad = await portal().forgot('not-an-email');
    expect(bad.statusCode).toBe(422);
    expect(problem(bad).errors?.map((e) => e.field)).toEqual(['email']);
    expect(problem(await portal().forgot('a@example.com', { origin: false })).code).toBe('CSRF_FAILED');
  });
});

describe('POST /client/auth/password/reset', () => {
  async function linkFor(merchantEmail: string) {
    await portal().forgot(merchantEmail);
    return emailedLinks().at(-1)!.token;
  }

  it('sets the password, uses the link up, ends every session and signs nobody in', async () => {
    const merchant = await makeMerchant(t);
    const open = await signedIn(merchant.email);
    const token = await linkFor(merchant.email);
    clock.advance(5 * 60_000);

    const res = await portal().reset(token, NEW_PASSWORD);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    expect((await clientRow(merchant.id)).passwordChangedAt?.getTime()).toBe(clock.nowMs());
    expect((await clientRow(merchant.id)).emailVerifiedAt).toBeNull();
    expect((await open.me()).statusCode).toBe(401);
    expect((await sessionsOf(merchant.id)).every((row) => row.revokedAt !== null)).toBe(true);

    expect((await portal().login(merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(401);
    expect((await portal().login(merchant.email, NEW_PASSWORD)).statusCode).toBe(200);
    const again = await portal().reset(token, 'another-new-password');
    expect(again.statusCode).toBe(410);
    expect(problem(again).code).toBe('TOKEN_INVALID');
  });

  it('keeps the status pending and, for an invitation, also marks the email verified', async () => {
    const invited = await makeMerchant(t, { status: 'pending', noPassword: true });
    const issued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(MerchantAuthTokens).issue(work, { clientId: invited.id, purpose: 'invite' }),
      );
    const { db } = await testDb();
    // A verification link from before is moot once the invitation proved the email.
    const verify = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(MerchantAuthTokens).issue(work, { clientId: invited.id, purpose: 'verify_email' }),
      );
    clock.advance(10 * 60_000);

    expect((await portal().reset(issued.token, NEW_PASSWORD)).statusCode).toBe(204);
    expect(await clientRow(invited.id)).toMatchObject({ status: 'pending' });
    expect((await clientRow(invited.id)).emailVerifiedAt?.getTime()).toBe(clock.nowMs());
    expect((await clientRow(invited.id)).passwordChangedAt?.getTime()).toBe(clock.nowMs());
    expect((await clientRow(invited.id)).passwordHash).toStartWith('$argon2id$');
    expect((await portal().verifyEmail(verify.token)).statusCode).toBe(410);
    // Every link of the merchant is used or voided now.
    expect(await db.select().from(s.authTokens).where(isNull(s.authTokens.usedAt))).toEqual([]);
    expect((await portal().login(invited.email, NEW_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('does not use the link up when the password is too weak (422 WEAK_PASSWORD on password)', async () => {
    const merchant = await makeMerchant(t);
    const token = await linkFor(merchant.email);
    for (const weak of ['short', 'password123', 'qwertyuiop']) {
      const res = await portal().reset(token, weak);
      expect(res.statusCode, weak).toBe(422);
      expect(problem(res).code).toBe('WEAK_PASSWORD');
      expect(problem(res).errors?.map((e) => e.field)).toEqual(['password']);
    }
    expect((await portal().reset(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('refuses an unknown link, an expired one, a link of another purpose and a suspended merchant with the same 410', async () => {
    const merchant = await makeMerchant(t);
    const token = await linkFor(merchant.email);
    expect((await portal().reset('A'.repeat(43), NEW_PASSWORD)).statusCode).toBe(410);

    const verifyIssued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(MerchantAuthTokens).issue(work, { clientId: merchant.id, purpose: 'verify_email' }),
      );
    expect((await portal().reset(verifyIssued.token, NEW_PASSWORD)).statusCode).toBe(410);

    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, merchant.id));
    expect((await portal().reset(token, NEW_PASSWORD)).statusCode).toBe(410);
    await db.update(s.clients).set({ status: 'active' }).where(eq(s.clients.id, merchant.id));

    clock.advance(HOUR + 1);
    const late = await portal().reset(token, NEW_PASSWORD);
    expect(late.statusCode).toBe(410);
    expect(problem(late).code).toBe('TOKEN_INVALID');
    expect((await portal().login(merchant.email, NEW_PASSWORD)).statusCode).toBe(401);
  });

  it('lets only one of two parallel requests use a link, and answers 422 for missing fields', async () => {
    const merchant = await makeMerchant(t);
    const token = await linkFor(merchant.email);
    const results = await Promise.all([
      portal().reset(token, NEW_PASSWORD),
      portal().reset(token, 'second-new-password'),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 410]);
    const empty = await portal().call('POST', '/client/auth/password/reset', {});
    expect(empty.statusCode).toBe(422);
    expect(
      problem(empty)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['password', 'token']);
  });

  it('turns two-factor sign-in off when the link is used on a merchant whose email is not verified (decision 052)', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: null });
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'totp' });
    const token = await linkFor(merchant.email);
    expect((await portal().reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });
    // A reset link does not verify the email; the new password signs in without a code.
    expect((await clientRow(merchant.id)).emailVerifiedAt).toBeNull();
    expect((await portal().login(merchant.email, NEW_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('turns two-factor sign-in off for an invitation link on an unverified merchant too, and verifies the email', async () => {
    const merchant = await makeMerchant(t, { status: 'pending', twofa: true, emailVerifiedAt: null });
    const issued = await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(MerchantAuthTokens).issue(work, { clientId: merchant.id, purpose: 'invite' }),
      );
    expect((await portal().reset(issued.token, NEW_PASSWORD)).statusCode).toBe(204);
    const row = await clientRow(merchant.id);
    expect(row).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
    expect(row.emailVerifiedAt?.getTime()).toBe(clock.nowMs());
    expect((await portal().login(merchant.email, NEW_PASSWORD)).json()).toEqual({ next: 'done' });
  });

  it('keeps two-factor sign-in of a merchant whose email is verified', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date() });
    const token = await linkFor(merchant.email);
    expect((await portal().reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({ twofaEnabled: true });
    expect((await portal().login(merchant.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp' });
  });

  it('counts link tries per address: the 31st in a minute is 429', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 30; i++) expect((await portal(ip).reset('A'.repeat(43), NEW_PASSWORD)).statusCode).toBe(410);
    const limited = await portal(ip).reset('A'.repeat(43), NEW_PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /client/security/password', () => {
  it('changes the password, keeps this session and ends the others, and voids an open reset link', async () => {
    const merchant = await makeMerchant(t);
    const here = await signedIn(merchant.email);
    const other = await signedIn(merchant.email);
    await portal().forgot(merchant.email);
    const resetToken = emailedLinks().at(-1)!.token;
    clock.advance(60_000);

    const res = await here.changePassword(MERCHANT_PASSWORD, NEW_PASSWORD);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await clientRow(merchant.id)).passwordChangedAt?.getTime()).toBe(clock.nowMs());
    expect((await here.me()).statusCode).toBe(200);
    expect((await other.me()).statusCode).toBe(401);
    expect(await liveSessionsOf(merchant.id)).toHaveLength(1);
    expect((await portal().reset(resetToken, 'yet-another-password')).statusCode).toBe(410);
    expect((await portal().login(merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(401);
    expect((await portal().login(merchant.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('answers a wrong current password with 422 on currentPassword and keeps the caller signed in', async () => {
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    const res = await p.changePassword('not-the-password', NEW_PASSWORD);
    expect(res.statusCode).toBe(422);
    expect(problem(res).code).toBe('VALIDATION_FAILED');
    expect(problem(res).errors?.map((e) => e.field)).toEqual(['currentPassword']);
    expect((await p.me()).statusCode).toBe(200);
    expect((await clientRow(merchant.id)).passwordChangedAt).toBeNull();
  });

  it('refuses a weak new password and the one in use, on newPassword', async () => {
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    for (const weak of ['short', 'password123', MERCHANT_PASSWORD]) {
      const res = await p.changePassword(MERCHANT_PASSWORD, weak);
      expect(res.statusCode, weak).toBe(422);
      expect(problem(res).code).toBe('WEAK_PASSWORD');
      expect(problem(res).errors?.map((e) => e.field)).toEqual(['newPassword']);
    }
    const missing = await p.call('POST', '/client/security/password', {});
    expect(
      problem(missing)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['currentPassword', 'newPassword']);
  });

  it('counts tries per account, so a stolen session cannot guess the current password', async () => {
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    for (let i = 0; i < 5; i++)
      expect((await p.changePassword('guess-number-' + i, NEW_PASSWORD)).statusCode).toBe(422);
    const locked = await p.changePassword(MERCHANT_PASSWORD, NEW_PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('needs a session and its CSRF token', async () => {
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    const noToken = await p.changePassword(MERCHANT_PASSWORD, NEW_PASSWORD, { csrf: false });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
    expect((await p.me()).statusCode).toBe(200);
    expect((await portal().changePassword(MERCHANT_PASSWORD, NEW_PASSWORD, { cookies: false })).statusCode).toBe(401);
  });
});

describe('the authenticator settings', () => {
  it('sets up a pending secret that is stored encrypted and leaves two-factor sign-in off', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const p = await signedIn(merchant.email);
    const res = await p.setupTwoFactor();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ secret: string; otpauthUrl: string; qrSvg: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);
    expect(body.otpauthUrl).toContain(encodeURIComponent(merchant.email));
    expect(body.qrSvg).toStartWith('<svg');

    const row = await clientRow(merchant.id);
    expect(row.twofaEnabled).toBe(false);
    expect(row.totpSecretEnc).toStartWith('v1:');
    expect(row.totpSecretEnc).not.toContain(body.secret);
    expect(t.app.get(EncryptionService).decrypt(row.totpSecretEnc!, CLIENT_TOTP_AAD)).toBe(body.secret);

    // A new call replaces the pending secret.
    const second = (await p.setupTwoFactor()).json<{ secret: string }>();
    expect(second.secret).not.toBe(body.secret);
    const next = await clientRow(merchant.id);
    expect(t.app.get(EncryptionService).decrypt(next.totpSecretEnc!, CLIENT_TOTP_AAD)).toBe(second.secret);
    // Sign-in still asks for no code: the secret is not confirmed.
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'done' });
  });

  it('turns two-factor sign-in on with a current code, ends the other sessions and then asks for the code at sign-in', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const here = await signedIn(merchant.email);
    const other = await signedIn(merchant.email);
    const { secret } = (await here.setupTwoFactor()).json<{ secret: string }>();

    const wrong = await here.enableTwoFactor('000000');
    expect(wrong.statusCode).toBe(422);
    expect(problem(wrong).errors?.map((e) => e.field)).toEqual(['code']);
    expect((await clientRow(merchant.id)).twofaEnabled).toBe(false);

    const enabled = await here.enableTwoFactor(await codeNow(secret));
    expect(enabled.statusCode).toBe(204);
    expect(enabled.body).toBe('');
    expect(await clientRow(merchant.id)).toMatchObject({
      twofaEnabled: true,
      totpLastStep: Math.floor(clock.nowMs() / 1000 / 30),
    });
    expect((await here.me()).json()).toMatchObject({ twofaEnabled: true });
    expect((await other.me()).statusCode).toBe(401);
    expect(await liveSessionsOf(merchant.id)).toHaveLength(1);

    // The code that confirmed it cannot sign in again; the next step's code can.
    const fresh = portal();
    expect((await fresh.login(merchant.email)).json()).toEqual({ next: 'totp' });
    expect((await fresh.code(await codeNow(secret))).statusCode).toBe(422);
    clock.advance(30 * SECOND);
    expect((await fresh.code(await codeNow(secret))).statusCode).toBe(204);
  });

  it('refuses a second setup or enable once it is on (409 TWOFA_ALREADY_ENABLED), and an enable without a setup', async () => {
    const plain = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const a = await signedIn(plain.email);
    const noSetup = await a.enableTwoFactor('123456');
    expect(noSetup.statusCode).toBe(422);
    expect(problem(noSetup).errors?.map((e) => e.field)).toEqual(['code']);

    const on = await makeMerchant(t, { twofa: true });
    const b = portal();
    await b.login(on.email);
    await b.code(await codeNow(on.secret));
    const setup = await b.setupTwoFactor();
    expect(setup.statusCode).toBe(409);
    expect(problem(setup).code).toBe('TWOFA_ALREADY_ENABLED');
    const enable = await b.enableTwoFactor(await codeNow(on.secret, 1));
    expect(enable.statusCode).toBe(409);
    expect(problem(enable).code).toBe('TWOFA_ALREADY_ENABLED');
    // The stored secret was not touched.
    expect((await clientRow(on.id)).totpSecretEnc).toBe(on.row.totpSecretEnc);
  });

  it('lets only one of two parallel enables win', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const p = await signedIn(merchant.email);
    const { secret } = (await p.setupTwoFactor()).json<{ secret: string }>();
    const code = await codeNow(secret);
    const results = await Promise.all([p.enableTwoFactor(code), p.enableTwoFactor(code)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 409]);
  });

  it('turns it off with a current code, forgets the secret and ends the other sessions', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    await p.login(merchant.email);
    await p.code(await codeNow(merchant.secret));
    const other = portal();
    await other.login(merchant.email);
    clock.advance(30 * SECOND);
    await other.code(await codeNow(merchant.secret));

    const wrong = await p.disableTwoFactor('000000');
    expect(wrong.statusCode).toBe(422);
    expect(problem(wrong).errors?.map((e) => e.field)).toEqual(['code']);
    expect((await clientRow(merchant.id)).twofaEnabled).toBe(true);

    clock.advance(30 * SECOND);
    const off = await p.disableTwoFactor(await codeNow(merchant.secret));
    expect(off.statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });
    expect((await p.me()).json()).toMatchObject({ twofaEnabled: false });
    expect((await other.me()).statusCode).toBe(401);
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'done' });
  });

  it('refuses a code that was just used to sign in, and 409 TWOFA_NOT_ENABLED when it is already off', async () => {
    const plain = await makeMerchant(t);
    const a = await signedIn(plain.email);
    const off = await a.disableTwoFactor('123456');
    expect(off.statusCode).toBe(409);
    expect(problem(off).code).toBe('TWOFA_NOT_ENABLED');

    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    await p.login(merchant.email);
    const code = await codeNow(merchant.secret);
    await p.code(code);
    const replay = await p.disableTwoFactor(code);
    expect(replay.statusCode).toBe(422);
    expect(problem(replay).errors?.map((e) => e.field)).toEqual(['code']);
    expect((await clientRow(merchant.id)).twofaEnabled).toBe(true);
  });

  it('counts code attempts per account and needs the CSRF token', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const p = await signedIn(merchant.email);
    await p.setupTwoFactor();
    expect(problem(await p.enableTwoFactor('123456', { csrf: false })).code).toBe('CSRF_FAILED');
    for (let i = 0; i < 5; i++) expect((await p.enableTwoFactor('000000')).statusCode).toBe(422);
    expect((await p.enableTwoFactor('000000')).statusCode).toBe(429);
    expect((await portal().setupTwoFactor({ cookies: false })).statusCode).toBe(401);
  });
});

describe('two-step sign-in needs a confirmed email address (decision 052)', () => {
  const REFUSAL = 'Confirm your email address first; two-step sign-in can be switched on after that.';
  const detailOf = (res: { json: () => unknown }) => res.json() as { code: string; detail: string };

  it('refuses a setup and an enable while the email is not verified, and stores no secret', async () => {
    const merchant = await makeMerchant(t);
    expect(merchant.row.emailVerifiedAt).toBeNull();
    const p = await signedIn(merchant.email);

    const setup = await p.setupTwoFactor();
    expect(setup.statusCode).toBe(409);
    expect(detailOf(setup)).toMatchObject({ code: 'CONFLICT', detail: REFUSAL });
    const enable = await p.enableTwoFactor('123456');
    expect(enable.statusCode).toBe(409);
    expect(detailOf(enable)).toMatchObject({ code: 'CONFLICT', detail: REFUSAL });

    expect(await clientRow(merchant.id)).toMatchObject({
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'done' });
  });

  it('refuses the confirmation of a secret that was stored before the rule, and leaves it as it was', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const { db } = await testDb();
    // A pending secret on an unconfirmed address, as rows from before the rule hold.
    await db.update(s.clients).set({ twofaEnabled: false }).where(eq(s.clients.id, merchant.id));
    const p = await signedIn(merchant.email);

    const enable = await p.enableTwoFactor(await codeNow(merchant.secret));
    expect(enable.statusCode).toBe(409);
    expect(detailOf(enable)).toMatchObject({ code: 'CONFLICT', detail: REFUSAL });
    const setup = await p.setupTwoFactor();
    expect(setup.statusCode).toBe(409);
    expect(await clientRow(merchant.id)).toMatchObject({
      twofaEnabled: false,
      totpSecretEnc: merchant.row.totpSecretEnc,
      totpLastStep: null,
    });
  });

  it('lets a merchant whose email is verified switch it on, as before', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date() });
    const p = await signedIn(merchant.email);
    const { secret } = (await p.setupTwoFactor()).json<{ secret: string }>();
    expect((await p.enableTwoFactor(await codeNow(secret))).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({ twofaEnabled: true });
    expect((await portal().login(merchant.email)).json()).toEqual({ next: 'totp' });
  });

  it('keeps the existing second step of an unconfirmed address working: sign-in with a code, and switching it off', async () => {
    // Rows from before the rule: 2FA is on and the address is not confirmed.
    const merchant = await makeMerchant(t, { twofa: true });
    const p = portal();
    expect((await p.login(merchant.email)).json()).toEqual({ next: 'totp' });
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(204);
    clock.advance(30 * SECOND);
    expect((await p.disableTwoFactor(await codeNow(merchant.secret))).statusCode).toBe(204);
    expect(await clientRow(merchant.id)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
  });

  it('from an unconfirmed address to a reset by link: the address is never enrolled before it is confirmed, and the sign-in asks for no second step', async () => {
    const email = 'unconfirmed-first@example.com';
    await makeMerchant(t, { email, name: 'Unconfirmed First', emailVerifiedAt: null, password: 'a-long-password' });
    const first = portal();
    expect((await first.login(email, 'a-long-password')).json()).toEqual({ next: 'done' });
    expect((await first.resendVerification()).statusCode).toBe(204);
    const verification = emailedLinks().find((link) => link.kind === 'email_verification')!;

    // Not confirmed yet: no enrolment.
    expect((await first.setupTwoFactor()).statusCode).toBe(409);
    expect((await first.enableTwoFactor('123456')).statusCode).toBe(409);

    // The mailbox is proven through its link, then a password reset by link follows.
    expect((await portal().verifyEmail(verification.token)).statusCode).toBe(204);
    expect((await portal().forgot(email)).statusCode).toBe(204);
    const reset = emailedLinks().findLast((link) => link.kind === 'password_reset')!;
    expect((await portal().reset(reset.token, NEW_PASSWORD)).statusCode).toBe(204);
    expect((await first.me()).statusCode).toBe(401);

    const owner = portal();
    const signIn = await owner.login(email, NEW_PASSWORD);
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json()).toEqual({ next: 'done' });
    const { db } = await testDb();
    const [row] = await db.select().from(s.clients).where(eq(s.clients.id, verification.clientId));
    expect(row).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
    expect(row!.emailVerifiedAt).not.toBeNull();
  });
});

describe('the per-device session list is retired', () => {
  it('has no GET /client/sessions and no DELETE /client/sessions/:id: both answer 404 and no session is touched', async () => {
    const merchant = await makeMerchant(t);
    const mine = await signedIn(merchant.email);
    await signedIn(merchant.email);
    const before = await liveSessionsOf(merchant.id);
    expect(before).toHaveLength(2);

    expect((await mine.call('GET', '/client/sessions')).statusCode).toBe(404);
    expect((await mine.call('DELETE', `/client/sessions/${before[0]!.id}`)).statusCode).toBe(404);
    expect(await liveSessionsOf(merchant.id)).toHaveLength(2);
    expect((await mine.me()).statusCode).toBe(200);
  });
});
