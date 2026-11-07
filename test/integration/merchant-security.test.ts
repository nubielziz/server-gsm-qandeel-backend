// Integration tests of the merchant portal's password links, security settings and devices (feature 2b, routes POST
// /client/auth/password/forgot and /reset, POST /client/security/password and /2fa/*, GET /client/sessions, DELETE
// /client/sessions/:id; MISMATCHES B127 and B128, B131 to B136) through HTTP on the real application.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq, isNull } from 'drizzle-orm';
import { schema as s, DbService } from '../../src/infra/db';
import { CLIENT_TOTP_AAD, MerchantAuthTokens } from '../../src/modules/identity';
import { EncryptionService } from '../../src/infra/crypto';
import { SESSION_COOKIE_NAMES, CSRF_COOKIE_NAMES } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { DAY, HOUR, SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
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
} from '../support/merchant-portal';
import { freshClientIp } from '../support/pipeline-routes';
import { codeFor } from '../support/staff-console';

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

  it('lets only the newest link work, and counts requests per email and address', async () => {
    const merchant = await makeMerchant(t);
    const ip = freshClientIp();
    await portal(ip).forgot(merchant.email);
    await portal(ip).forgot(merchant.email);
    const [older, newer] = emailedLinks();
    expect((await portal().reset(older!.token, NEW_PASSWORD)).statusCode).toBe(410);
    expect((await portal().reset(newer!.token, NEW_PASSWORD)).statusCode).toBe(204);

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
    // A verification link from an earlier registration is moot once the invitation proved the email.
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
    const merchant = await makeMerchant(t);
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
    const merchant = await makeMerchant(t);
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
    const plain = await makeMerchant(t);
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
    const merchant = await makeMerchant(t);
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
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    await p.setupTwoFactor();
    expect(problem(await p.enableTwoFactor('123456', { csrf: false })).code).toBe('CSRF_FAILED');
    for (let i = 0; i < 5; i++) expect((await p.enableTwoFactor('000000')).statusCode).toBe(422);
    expect((await p.enableTwoFactor('000000')).statusCode).toBe(429);
    expect((await portal().setupTwoFactor({ cookies: false })).statusCode).toBe(401);
  });
});

describe('GET /client/sessions and DELETE /client/sessions/:id', () => {
  it("lists the caller's live sessions newest first, marks the current one and never shows a token", async () => {
    const merchant = await makeMerchant(t);
    const first = await signedIn(merchant.email);
    clock.advance(1_000);
    const second = await signedIn(merchant.email);
    const stranger = await makeMerchant(t);
    await signedIn(stranger.email);

    const res = await second.sessions();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    const rows = res.json<Array<Record<string, unknown>>>();
    expect(rows.map((row) => row.current)).toEqual([true, false]);
    expect(rows[0]).toEqual({
      id: expect.any(Number),
      ip: expect.any(String),
      userAgent: expect.any(String),
      lastSeenAt: expect.stringMatching(/Z$/),
      createdAt: expect.stringMatching(/Z$/),
      expiresAt: expect.stringMatching(/Z$/),
      current: true,
    });
    expect(JSON.stringify(rows)).not.toContain(second.sessionToken!);
    expect(JSON.stringify(rows)).not.toContain(first.sessionToken!);
    expect(new Date(rows[0]!.createdAt as string).getTime()).toBeGreaterThan(
      new Date(rows[1]!.createdAt as string).getTime(),
    );

    // Range and sort of the simple-rest dialect.
    const page = await second.sessions('?_start=1&_end=2');
    expect(page.headers['x-total-count']).toBe('2');
    expect(page.json<Array<{ current: boolean }>>().map((row) => row.current)).toEqual([false]);
    const sorted = await second.sessions('?_sort=createdAt&_order=asc');
    expect(sorted.json<Array<{ current: boolean }>>().map((row) => row.current)).toEqual([false, true]);
    expect(problem(await second.sessions('?_sort=ip')).code).toBe('VALIDATION_FAILED');
  });

  it('leaves out ended sessions, pending code steps and sessions that sat idle longer than the limit', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const { db } = await testDb();
    const idle = await openSession(t, { type: 'client', id: merchant.id });
    clock.advance(6 * DAY);
    const ended = await openSession(t, { type: 'client', id: merchant.id });
    const pending = await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const caller = portal();
    await caller.login(merchant.email);
    await caller.code(await codeNow(merchant.secret));
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, ended.sessionId));
    clock.advance(2 * DAY);
    // The first session was last used 8 days ago (the limit is 7); the caller's was created 2 days ago.
    await caller.me();

    const rows = (await caller.sessions()).json<Array<{ id: number; current: boolean }>>();
    expect(rows.map((row) => row.current)).toEqual([true]);
    expect(rows.map((row) => row.id)).not.toContain(idle.sessionId);
    expect(rows.map((row) => row.id)).not.toContain(pending.sessionId);
    expect(rows.map((row) => row.id)).not.toContain(ended.sessionId);
    expect((await caller.sessions()).headers['x-total-count']).toBe('1');
  });

  it("ends another of the caller's sessions with 204, and then it is gone: 404 the second time, 401 for its owner", async () => {
    const merchant = await makeMerchant(t);
    const mine = await signedIn(merchant.email);
    const other = await signedIn(merchant.email);
    const target = (await mine.sessions()).json<Array<{ id: number; current: boolean }>>().find((row) => !row.current)!;

    const res = await mine.endSession(target.id);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    expect((await other.me()).statusCode).toBe(401);
    expect((await mine.me()).statusCode).toBe(200);
    expect((await mine.sessions()).headers['x-total-count']).toBe('1');
    const again = await mine.endSession(target.id);
    expect(again.statusCode).toBe(404);
    expect(problem(again).code).toBe('NOT_FOUND');
  });

  it('signs the caller out when it ends its own session, clearing the cookies', async () => {
    const merchant = await makeMerchant(t);
    const p = await signedIn(merchant.email);
    const current = (await p.sessions()).json<Array<{ id: number; current: boolean }>>().find((row) => row.current)!;
    const res = await p.endSession(current.id);
    expect(res.statusCode).toBe(204);
    expect(res.cookies.map((cookie) => [cookie.name, cookie.maxAge]).sort()).toEqual(
      [
        [CSRF_COOKIE_NAMES.client, 0],
        [SESSION_COOKIE_NAMES.client, 0],
      ].sort(),
    );
    expect(await liveSessionsOf(merchant.id)).toHaveLength(0);
  });

  it("answers 404 for another merchant's session, an unknown id, a revoked one and a pending code step; never touches them", async () => {
    const merchant = await makeMerchant(t);
    const stranger = await makeMerchant(t);
    const mine = await signedIn(merchant.email);
    const theirs = await openSession(t, { type: 'client', id: stranger.id });
    const revoked = await openSession(t, { type: 'client', id: merchant.id });
    const pending = await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const { db } = await testDb();
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, revoked.sessionId));

    for (const id of [theirs.sessionId, 999_999, revoked.sessionId, pending.sessionId]) {
      const res = await mine.endSession(id);
      expect(res.statusCode, String(id)).toBe(404);
      expect(problem(res).code).toBe('NOT_FOUND');
    }
    expect(await liveSessionsOf(stranger.id)).toHaveLength(1);
    expect((await liveSessionsOf(merchant.id)).some((row) => row.id === pending.sessionId)).toBe(true);
    const bad = await mine.call('DELETE', '/client/sessions/abc');
    expect(bad.statusCode).toBe(422);
  });

  it('needs a session, and the CSRF token to end one', async () => {
    const merchant = await makeMerchant(t);
    const mine = await signedIn(merchant.email);
    await signedIn(merchant.email);
    const target = (await mine.sessions()).json<Array<{ id: number; current: boolean }>>().find((row) => !row.current)!;
    const noToken = await mine.endSession(target.id, { csrf: false });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
    expect((await portal().sessions('', { cookies: false })).statusCode).toBe(401);
    expect((await portal().endSession(target.id, { cookies: false })).statusCode).toBe(401);
    expect((await mine.sessions()).headers['x-total-count']).toBe('2');
  });
});
