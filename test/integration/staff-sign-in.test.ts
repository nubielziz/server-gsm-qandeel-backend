// Integration tests of the staff sign-in (P2.6, routes /admin/auth/*) through HTTP on the real application: the frontend's
// flow (login, setup, 2fa, me, logout), the temporary-password and invite-link flows, and every refusal the contract lists.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { PasswordHasher, TokenService } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { RateLimitService } from '../../src/infra/rate-limit';
import { RedisService } from '../../src/infra/redis';
import { DEV_PASSWORD, DEV_TOTP_SECRETS, seedDevCredentials } from '../../scripts/seed/dev-credentials';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { logSink } from '../support/log-sink';
import {
  CSRF_COOKIE_NAMES,
  IpRuleCache,
  SESSION_COOKIE_NAMES,
  STAFF_TOKEN_TTL_MS,
  SessionService,
  StaffAuthTokens,
  csrfTokenFor,
} from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import { CONSOLE_ORIGIN, PASSWORD, StaffConsole, codeFor, makeStaff, stepsFromNow } from '../support/staff-console';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

/** Deletes the rate-limit counters of the three limiters the sign-in touches (the Redis instance outlives the tests). */
async function clearRateLimits(): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const keys = t.app.get(CacheKeys);
  for (const limiter of ['ip', 'sign-in', 'token'] as const) {
    const found = await redis.keys(`${keys.rateLimit(limiter)}:*`);
    if (found.length > 0) await redis.del(...found);
  }
}

beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits();
  logSink.clear();
});
afterEach(async () => {
  const { db } = await testDb();
  await db.delete(s.ipRules);
  await db.delete(s.settings);
  await t.app.get(IpRuleCache).invalidate();
});

const consoleOf = (ip?: string) => new StaffConsole(t, ip);
const staffRow = async (id: number) => {
  const { db } = await testDb();
  const [row] = await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id));
  return row!;
};
const sessionsOf = async (staffId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, staffId)).orderBy(asc(s.sessions.id));
};
const auditRows = async () => {
  const { db } = await testDb();
  return db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id));
};
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };

/** Signs a staff member in completely (login + code) and returns the console that holds the full session. */
async function signedIn(staff: { email: string; secret: string }, ip?: string): Promise<StaffConsole> {
  const c = consoleOf(ip);
  expect((await c.login(staff.email)).statusCode).toBe(200);
  expect((await c.code(await codeFor(staff.secret))).statusCode).toBe(204);
  return c;
}

describe('the whole flow of a member with 2FA on', () => {
  it('login → code → me → logout, with the cookies, the CSRF token and the rotation the console expects', async () => {
    const staff = await makeStaff(t, { status: 'invited' });
    const c = consoleOf();

    const login = await c.login(staff.email.toUpperCase());
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: 'totp' });
    expect(login.headers['cache-control']).toBe('no-store');
    const pendingToken = c.sessionToken!;
    const sessionCookie = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.staff)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(sessionCookie.maxAge).toBeLessThanOrEqual(600);
    const csrfCookie = login.cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAMES.staff)!;
    expect(csrfCookie.httpOnly).toBeFalsy();
    const tokens = t.app.get(TokenService);
    const expectedCsrf = csrfTokenFor(t.config.security.csrfSecret, tokens.hash(pendingToken));
    expect(csrfCookie.value).toBe(expectedCsrf);
    expect(login.headers['x-csrf-token']).toBe(expectedCsrf);

    // Nothing is signed in yet: no last-login stamp, and a pending session cannot call `me`.
    expect(await staffRow(staff.id)).toMatchObject({ lastLoginAt: null, lastLoginIp: null, status: 'invited' });
    const early = await c.me();
    expect(early.statusCode).toBe(401);
    expect(problem(early).code).toBe('UNAUTHORIZED');

    const done = await c.code(await codeFor(staff.secret));
    expect(done.statusCode).toBe(204);
    expect(done.body).toBe('');
    expect(c.sessionToken).not.toBe(pendingToken);
    expect(done.headers['x-csrf-token']).toBe(csrfTokenFor(t.config.security.csrfSecret, tokens.hash(c.sessionToken!)));
    const fullCookie = done.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.staff)!;
    expect(fullCookie.maxAge).toBeGreaterThan(8 * 3600 - 60);

    // The pending token died with the rotation (no fixation).
    const stale = consoleOf();
    stale.setSessionToken(pendingToken);
    expect((await stale.me()).statusCode).toBe(401);

    const me = await c.me();
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.headers['x-csrf-token']).toBe(c.csrf);
    const body = me.json<Record<string, unknown>>();
    expect(body).toEqual({
      id: staff.id,
      email: staff.email,
      name: 'Test Staff',
      status: 'active',
      role: { id: staff.row.roleId, name: expect.any(String) },
      permissions: ['orders:read', 'staff:*'],
      twofaEnabled: true,
      mustChangePassword: false,
      lastLoginAt: expect.stringMatching(/Z$/),
      lastLoginIp: '127.0.0.1',
    });
    // `invited` became `active` at the first full sign-in.
    expect(await staffRow(staff.id)).toMatchObject({ status: 'active', lastLoginIp: '127.0.0.1' });

    const out = await c.logout();
    expect(out.statusCode).toBe(204);
    expect(out.cookies.map((cookie) => [cookie.name, cookie.value, cookie.maxAge])).toEqual([
      [SESSION_COOKIE_NAMES.staff, '', 0],
      [CSRF_COOKIE_NAMES.staff, '', 0],
    ]);
    expect(c.sessionToken).toBeUndefined();
    // Whoever kept the token is signed out too.
    const kept = consoleOf();
    kept.setSessionToken(fullCookie.value);
    expect((await kept.me()).statusCode).toBe(401);
    const all = await sessionsOf(staff.id);
    expect(all.filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect(all.map((row) => row.stage)).toEqual(['pending_totp', 'active']);
  });

  it('writes audit rows for the sign-in and the sign-out, never for the first step', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    expect(await auditRows()).toHaveLength(0);
    await c.code(await codeFor(staff.secret));
    await c.logout();
    const rows = await auditRows();
    const active = (await sessionsOf(staff.id)).find((row) => row.stage === 'active')!;
    expect(rows.map((row) => [row.action, row.entityType, row.entityId, row.actorType, row.actorId, row.ip])).toEqual([
      ['logged in', 'session', active.id, 'staff', staff.id, '127.0.0.1'],
      ['logged out', 'session', active.id, 'staff', staff.id, '127.0.0.1'],
    ]);
    expect(rows.every((row) => row.entityLabel === 'Test Staff' && row.before === null && row.after === null)).toBe(
      true,
    );
  });

  it('keeps secrets out of the audit log and the application log', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    await c.logout();
    const failing = consoleOf();
    await failing.login(staff.email, 'not-the-password');
    const text = JSON.stringify(await auditRows()) + JSON.stringify(logSink.lines);
    for (const secret of [PASSWORD, staff.secret, 'not-the-password', staff.email]) {
      expect(text).not.toContain(secret);
    }
  });

  it('stores the sign-in session with the caller address and user agent', async () => {
    const staff = await makeStaff(t);
    const ip = freshClientIp();
    const c = consoleOf(ip);
    await c.login(staff.email);
    const [pending] = await sessionsOf(staff.id);
    expect(pending).toMatchObject({ stage: 'pending_totp', ip, revokedAt: null });
    expect(Math.round((pending!.expiresAt.getTime() - pending!.createdAt.getTime()) / 60_000)).toBe(10);
  });

  it('ends a session cookie the login request already carried', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    const first = c.sessionToken!;
    expect((await c.login(staff.email)).statusCode).toBe(200);
    expect(c.sessionToken).not.toBe(first);
    const old = consoleOf();
    old.setSessionToken(first);
    expect((await old.me()).statusCode).toBe(401);
  });

  it('answers `me` with the role permissions of the database, without duplicates', async () => {
    const staff = await makeStaff(t, { permissions: ['orders:*', 'orders:*', 'risk:read'] });
    const c = await signedIn(staff);
    expect((await c.me()).json<{ permissions: string[] }>().permissions).toEqual(['orders:*', 'risk:read']);
  });
});

describe('first sign-in: authenticator setup', () => {
  it('login → setup → code turns 2FA on and signs in', async () => {
    const staff = await makeStaff(t, { status: 'invited', twofaEnabled: false, noSecret: true });
    const c = consoleOf();
    expect((await c.login(staff.email)).json()).toEqual({ next: 'totp_setup' });

    const setup = await c.setup();
    expect(setup.statusCode).toBe(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    const body = setup.json<{ secret: string; otpauthUrl: string; qrSvg: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUrl).toStartWith('otpauth://totp/GSM%20Supply:');
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);
    expect(body.qrSvg).toStartWith('<svg');

    // The secret is stored encrypted and still pending.
    const pending = await staffRow(staff.id);
    expect(pending).toMatchObject({ twofaEnabled: false, totpLastStep: null });
    expect(pending.totpSecretEnc).toStartWith('v1:');
    expect(pending.totpSecretEnc).not.toContain(body.secret);

    expect((await c.code(await codeFor(body.secret))).statusCode).toBe(204);
    expect(await staffRow(staff.id)).toMatchObject({ twofaEnabled: true, status: 'active' });
    expect((await c.me()).statusCode).toBe(200);
    expect((await auditRows()).map((row) => row.action)).toEqual(['turned on two-factor sign-in', 'logged in']);

    // The next sign-in asks for the code.
    const again = consoleOf();
    expect((await again.login(staff.email)).json()).toEqual({ next: 'totp' });
  });

  it('a new setup call replaces the pending secret, and only the newest one confirms', async () => {
    const staff = await makeStaff(t, { twofaEnabled: false, noSecret: true });
    const c = consoleOf();
    await c.login(staff.email);
    const first = (await c.setup()).json<{ secret: string }>().secret;
    const second = (await c.setup()).json<{ secret: string }>().secret;
    expect(second).not.toBe(first);
    const old = await c.code(await codeFor(first));
    expect(old.statusCode).toBe(422);
    expect((await c.code(await codeFor(second))).statusCode).toBe(204);
  });

  it('a code before any setup is a 422 on `code`, not a crash', async () => {
    const staff = await makeStaff(t, { twofaEnabled: false, noSecret: true });
    const c = consoleOf();
    await c.login(staff.email);
    const res = await c.code('123456');
    expect(res.statusCode).toBe(422);
    expect(problem(res).errors![0]!.field).toBe('code');
  });

  it('refuses a new authenticator once 2FA is on (409), and in the wrong step (401)', async () => {
    const staff = await makeStaff(t, { twofaEnabled: false, noSecret: true });
    // Two tabs: both hold a pending setup session; the first confirms.
    const tabA = consoleOf();
    const tabB = consoleOf();
    await tabA.login(staff.email);
    await tabB.login(staff.email);
    const secret = (await tabA.setup()).json<{ secret: string }>().secret;
    expect((await tabA.code(await codeFor(secret))).statusCode).toBe(204);
    const late = await tabB.setup();
    expect(late.statusCode).toBe(409);
    expect(problem(late).code).toBe('TWOFA_ALREADY_ENABLED');

    // A member who is asked for a code cannot start a setup with just the password.
    const asked = consoleOf();
    await asked.login(staff.email);
    expect((await asked.setup()).statusCode).toBe(401);
    expect(await staffRow(staff.id)).toMatchObject({ twofaEnabled: true });
  });

  it('a full session is not a sign-in step: setup and code are 401', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    expect((await c.setup()).statusCode).toBe(401);
    expect((await c.code('123456')).statusCode).toBe(401);
  });

  it('limits setups per account (429 with Retry-After)', async () => {
    const staff = await makeStaff(t, { twofaEnabled: false, noSecret: true });
    const c = consoleOf();
    await c.login(staff.email);
    for (let i = 0; i < 5; i++) expect((await c.setup()).statusCode).toBe(200);
    const blocked = await c.setup();
    expect(blocked.statusCode).toBe(429);
    expect(problem(blocked).code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('login refusals', () => {
  it('422 names the fields that are missing or blank', async () => {
    const c = consoleOf();
    const res = await c.call('POST', '/admin/auth/login', { email: '  ', password: '' });
    expect(res.statusCode).toBe(422);
    expect(
      problem(res)
        .errors!.map((error) => error.field)
        .sort(),
    ).toEqual(['email', 'password']);
    const none = await c.call('POST', '/admin/auth/login', {});
    expect(
      problem(none)
        .errors!.map((error) => error.field)
        .sort(),
    ).toEqual(['email', 'password']);
  });

  it('answers 401 the same for an unknown email, a wrong password and an account with no password yet', async () => {
    const known = await makeStaff(t);
    const invited = await makeStaff(t, { status: 'invited', noPassword: true });
    const answers = [];
    for (const [email, password] of [
      ['nobody@example.com', PASSWORD],
      [known.email, 'wrong-password-123'],
      [invited.email, PASSWORD],
    ] as const) {
      const res = await consoleOf().login(email, password);
      expect(res.statusCode).toBe(401);
      expect(res.cookies).toHaveLength(0);
      const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>();
      answers.push(rest);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('does the password work for an unknown email too (a dummy hash), so the answer is not faster', async () => {
    const known = await makeStaff(t);
    const invited = await makeStaff(t, { noPassword: true });
    const verify = spyOn(t.app.get(PasswordHasher), 'verify');
    try {
      await consoleOf().login(known.email, 'wrong-password-123');
      const afterWrong = verify.mock.calls.length;
      await consoleOf().login('nobody@example.com', 'wrong-password-123');
      await consoleOf().login(invited.email, 'wrong-password-123');
      // Every attempt verifies one hash: the real one, or a dummy hash made at the configured cost for an account that
      // cannot be checked, so the unknown email and the missing password take as long as a wrong password.
      expect(afterWrong).toBe(1);
      expect(verify.mock.calls.length).toBe(3);
    } finally {
      verify.mockRestore();
    }
  });

  it('403 ACCOUNT_SUSPENDED for a correct password only; a wrong one stays 401', async () => {
    const suspended = await makeStaff(t, { status: 'suspended', suspendedAt: new Date(), suspendedReason: 'test' });
    const ok = await consoleOf().login(suspended.email);
    expect(ok.statusCode).toBe(403);
    expect(problem(ok).code).toBe('ACCOUNT_SUSPENDED');
    expect(ok.cookies).toHaveLength(0);
    expect((await consoleOf().login(suspended.email, 'wrong-password-123')).statusCode).toBe(401);
    expect(await sessionsOf(suspended.id)).toHaveLength(0);
  });

  it('403 IP_NOT_ALLOWED before the credentials are even looked at', async () => {
    const staff = await makeStaff(t);
    const ip = freshClientIp();
    const { db } = await testDb();
    await db.insert(s.ipRules).values({ kind: 'block', scope: 'admin', cidr: `${ip}/32`, reason: 'test' });
    await t.app.get(IpRuleCache).invalidate();

    const blocked = consoleOf(ip);
    const res = await blocked.login(staff.email);
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('IP_NOT_ALLOWED');
    expect(res.cookies).toHaveLength(0);
    expect(await sessionsOf(staff.id)).toHaveLength(0);

    // The same member from another address signs in; and an open session is refused from the blocked address.
    const open = await openSession(t, { type: 'staff', id: staff.id });
    const me = await t.app.inject({ method: 'GET', url: '/admin/auth/me', headers: open.headers, remoteAddress: ip });
    expect(me.statusCode).toBe(403);
    expect(problem(me).code).toBe('IP_NOT_ALLOWED');
    expect((await consoleOf().login(staff.email)).statusCode).toBe(200);
  });

  it('403 CSRF_FAILED without an allowed Origin (there is no session to bind a token to)', async () => {
    const staff = await makeStaff(t);
    const none = await consoleOf().login(staff.email, PASSWORD, { origin: false });
    expect(none.statusCode).toBe(403);
    expect(problem(none).code).toBe('CSRF_FAILED');
    const other = await consoleOf().login(staff.email, PASSWORD, { origin: 'https://evil.example.com' });
    expect(other.statusCode).toBe(403);
    expect(await sessionsOf(staff.id)).toHaveLength(0);
  });

  it('429 with Retry-After from the sixth attempt; a success clears the count', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    for (let i = 0; i < 4; i++) expect((await c.login(staff.email, 'wrong-password-123')).statusCode).toBe(401);
    expect((await c.login(staff.email)).statusCode).toBe(200);
    // The counter restarted: four more failures are still plain 401s.
    for (let i = 0; i < 4; i++) expect((await c.login(staff.email, 'wrong-password-123')).statusCode).toBe(401);
    expect((await c.login(staff.email, 'wrong-password-123')).statusCode).toBe(401);
    const locked = await c.login(staff.email);
    expect(locked.statusCode).toBe(429);
    expect(problem(locked).code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // Other addresses and other emails are not locked by this pair.
    expect((await consoleOf(freshClientIp()).login(staff.email)).statusCode).toBe(200);
  });

  it('keeps the email out of the Redis keys of the limiter (a keyed hash, not a bare SHA-256)', async () => {
    const staff = await makeStaff(t);
    await consoleOf().login(staff.email, 'wrong-password-123');
    const prefix = t.app.get(CacheKeys).rateLimit('sign-in');
    const found = await t.app.get(RedisService).cache.keys(`${prefix}:*`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`^${prefix}:[0-9a-f]{64}$`));
    expect(found[0]).not.toContain(staff.email);
    expect(found[0]).not.toContain(RateLimitService.compositeKey(staff.email, '127.0.0.1'));
  });

  it('upgrades a password hash made with a lower cost', async () => {
    const { parseEnv } = await import('../../src/config');
    const weak = new PasswordHasher(parseEnv({ NODE_ENV: 'test', ARGON2_MEMORY_KIB: '8192', ARGON2_TIME_COST: '1' }));
    const staff = await makeStaff(t, { passwordHash: await weak.hash(PASSWORD) });
    const before = staff.row.passwordHash!;
    expect((await consoleOf().login(staff.email)).statusCode).toBe(200);
    const after = (await staffRow(staff.id)).passwordHash!;
    expect(after).not.toBe(before);
    expect(after).toContain('m=19456');
    expect(await t.app.get(PasswordHasher).verify(after, PASSWORD)).toBe(true);
  });

  it('answers `next: password` first when a password change is due, whatever the 2FA state', async () => {
    const both = await makeStaff(t, { mustChangePassword: true });
    const noTwofa = await makeStaff(t, { mustChangePassword: true, twofaEnabled: false, noSecret: true });
    expect((await consoleOf().login(both.email)).json()).toEqual({ next: 'password' });
    expect((await consoleOf().login(noTwofa.email)).json()).toEqual({ next: 'password' });
  });
});

describe('the code step', () => {
  it('422 on `code` for a wrong code or a malformed one; no cookie change, the session stays', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    const token = c.sessionToken;
    for (const code of ['000000', '12345', 'abcdef', '1234567', ' 123456']) {
      const res = await c.code(code);
      expect(res.statusCode).toBe(422);
      expect(problem(res).errors![0]!.field).toBe('code');
    }
    expect(c.sessionToken).toBe(token);
    expect((await c.code(await codeFor(staff.secret))).statusCode).toBe(204);
  });

  it('accepts a code one step ahead and refuses one three steps away', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    expect((await c.code(await codeFor(staff.secret, stepsFromNow(-3)))).statusCode).toBe(422);
    expect((await c.code(await codeFor(staff.secret, stepsFromNow(3)))).statusCode).toBe(422);
    expect((await c.code(await codeFor(staff.secret, stepsFromNow(1)))).statusCode).toBe(204);
    const stepOfCode = Math.floor(stepsFromNow(1) / 30_000);
    expect(Math.abs((await staffRow(staff.id)).totpLastStep! - stepOfCode)).toBeLessThanOrEqual(1);
  });

  it('never accepts a used time step twice, not even from another session', async () => {
    const staff = await makeStaff(t);
    const code = await codeFor(staff.secret);
    const first = consoleOf();
    const second = consoleOf();
    await first.login(staff.email);
    await second.login(staff.email);
    expect((await first.code(code)).statusCode).toBe(204);
    const replay = await second.code(code);
    expect(replay.statusCode).toBe(422);
    expect(problem(replay).errors![0]!.field).toBe('code');
    // An older step is refused too (the account moved past it); a newer one is accepted.
    expect((await second.code(await codeFor(staff.secret, stepsFromNow(-1)))).statusCode).toBe(422);
    expect((await second.code(await codeFor(staff.secret, stepsFromNow(1)))).statusCode).toBe(204);
  });

  it('lets exactly one of two simultaneous requests with the same code win', async () => {
    const staff = await makeStaff(t);
    const code = await codeFor(staff.secret);
    const tabs = [consoleOf(), consoleOf(), consoleOf()];
    for (const tab of tabs) await tab.login(staff.email);
    const results = await Promise.all(tabs.map((tab) => tab.code(code)));
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 422, 422]);
    expect((await auditRows()).filter((row) => row.action === 'logged in')).toHaveLength(1);
    expect((await sessionsOf(staff.id)).filter((row) => row.stage === 'active')).toHaveLength(1);
  });

  it('limits attempts per account, across sessions (429 with Retry-After), and a right code clears the count', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    for (let i = 0; i < 4; i++) expect((await c.code('000000')).statusCode).toBe(422);
    expect((await c.code(await codeFor(staff.secret))).statusCode).toBe(204);
    // The count restarted; a thief with the password gets no fresh guesses by logging in again.
    const thief = consoleOf();
    for (let i = 0; i < 5; i++) {
      await thief.login(staff.email);
      expect((await thief.code('000000')).statusCode).toBe(422);
    }
    await thief.login(staff.email);
    const blocked = await thief.code('000000');
    expect(blocked.statusCode).toBe(429);
    expect(problem(blocked).code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right code waits while the account is locked.
    const right = await thief.code(await codeFor(staff.secret, stepsFromNow(1)));
    expect(right.statusCode).toBe(429);
  });

  it('403 CSRF_FAILED without the token; the session survives and works with it', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    const code = await codeFor(staff.secret);
    for (const csrf of [false, 'f'.repeat(64)] as const) {
      const res = await c.code(code, { csrf });
      expect(res.statusCode).toBe(403);
      expect(problem(res).code).toBe('CSRF_FAILED');
    }
    expect((await c.code(code)).statusCode).toBe(204);
  });

  it('401 without a session, with a revoked one, and after the pending time ran out', async () => {
    const staff = await makeStaff(t);
    expect((await consoleOf().code('123456', { csrf: 'x' })).statusCode).toBe(401);
    const c = consoleOf();
    await c.login(staff.email);
    await c.logout();
    expect((await c.code('123456')).statusCode).toBe(401);

    const short = await openSession(t, { type: 'staff', id: staff.id }, { stage: 'pending_totp', ttlSeconds: 1 });
    await Bun.sleep(1100);
    const expired = await t.app.inject({
      method: 'POST',
      url: '/admin/auth/2fa',
      headers: { ...short.mutationHeaders, origin: CONSOLE_ORIGIN },
      payload: { code: '123456' },
    });
    expect(expired.statusCode).toBe(401);
  });

  it('rechecks the account in the database: a member suspended after login is refused (403) and signed out everywhere', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    await c.me(); // warms the cached session view, which still says "ok" after the update below
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staff.id));
    const res = await c.code(await codeFor(staff.secret));
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
    expect((await sessionsOf(staff.id)).filter((row) => row.revokedAt === null)).toHaveLength(0);
  });

  it('goes back to the sign-in when the account moved on (a temporary password was set meanwhile)', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    await c.login(staff.email);
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ mustChangePassword: true }).where(eq(s.staffUsers.id, staff.id));
    expect((await c.code(await codeFor(staff.secret))).statusCode).toBe(401);
  });
});

describe('me and logout', () => {
  it('me is 401 without a session and with every pending stage', async () => {
    const staff = await makeStaff(t);
    expect((await consoleOf().me()).statusCode).toBe(401);
    for (const stage of ['pending_password', 'pending_totp_setup', 'pending_totp'] as const) {
      const session = await openSession(t, { type: 'staff', id: staff.id }, { stage });
      const res = await t.app.inject({ method: 'GET', url: '/admin/auth/me', headers: session.headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('me answers 403 for an account suspended in the database even while the cached session still says ok', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    expect((await c.me()).statusCode).toBe(200);
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staff.id));
    const res = await c.me();
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
    expect((await c.me()).statusCode).toBe(401);
  });

  it('logout works at every stage; a pending step ends without an audit row', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true });
    const c = consoleOf();
    await c.login(staff.email); // pending_password
    expect((await c.logout()).statusCode).toBe(204);
    expect(await auditRows()).toHaveLength(0);
    for (const stage of ['pending_totp_setup', 'pending_totp'] as const) {
      const session = await openSession(t, { type: 'staff', id: staff.id }, { stage });
      const res = await t.app.inject({
        method: 'POST',
        url: '/admin/auth/logout',
        headers: { ...session.mutationHeaders, origin: CONSOLE_ORIGIN },
      });
      expect(res.statusCode).toBe(204);
    }
  });

  it('logout needs the CSRF token (403, never a sign-out) and a second logout is a 401', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    const refused = await c.logout({ csrf: false });
    expect(refused.statusCode).toBe(403);
    expect(problem(refused).code).toBe('CSRF_FAILED');
    expect((await c.me()).statusCode).toBe(200);
    const saved = c.sessionToken!;
    expect((await c.logout()).statusCode).toBe(204);
    c.setSessionToken(saved);
    expect((await c.logout()).statusCode).toBe(401);
  });

  it('a suspended account that signs out loses every session', async () => {
    const staff = await makeStaff(t);
    const a = await signedIn(staff);
    await a.me(); // warms the cached session view, which still says "ok" after the update below
    const b = consoleOf();
    await b.login(staff.email);
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staff.id));
    expect((await a.logout()).statusCode).toBe(204);
    expect((await sessionsOf(staff.id)).filter((row) => row.revokedAt === null)).toHaveLength(0);
  });
});

describe('password set after a temporary password (session mode)', () => {
  const NEW_PASSWORD = 'a-brand-new-passphrase';

  it('login → password/set → login again → 2FA, and nothing signs in on the way', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true, password: 'temporary-pass-9' });
    const c = consoleOf();
    expect((await c.login(staff.email, 'temporary-pass-9')).json()).toEqual({ next: 'password' });
    // A pending password session unlocks only the password change and the logout.
    expect((await c.me()).statusCode).toBe(401);
    expect((await c.setup()).statusCode).toBe(401);
    expect((await c.code('123456')).statusCode).toBe(401);

    const res = await c.setPassword({ password: NEW_PASSWORD });
    expect(res.statusCode).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.cookies).toHaveLength(0);
    expect((await sessionsOf(staff.id)).filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect((await c.me()).statusCode).toBe(401);

    const row = await staffRow(staff.id);
    expect(row).toMatchObject({ mustChangePassword: false, lastLoginAt: null });
    expect(row.passwordChangedAt).toBeInstanceOf(Date);
    expect(row.passwordHash).toStartWith('$argon2id$');

    expect((await consoleOf().login(staff.email, 'temporary-pass-9')).statusCode).toBe(401);
    const again = consoleOf();
    expect((await again.login(staff.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await again.code(await codeFor(staff.secret))).statusCode).toBe(204);
    const audit = (await auditRows()).map((entry) => [entry.action, entry.entityType, entry.actorType, entry.actorId]);
    expect(audit[0]).toEqual(['set a new password', 'staff', 'staff', staff.id]);
  });

  it('422 WEAK_PASSWORD on `password` for a weak, short, familiar or unchanged password; the flag stays', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true, password: 'temporary-pass-9' });
    const c = consoleOf();
    await c.login(staff.email, 'temporary-pass-9');
    for (const password of [
      'short1',
      '1111111111',
      'Password123!',
      '1234567890',
      'temporary-pass-9',
      'test-staff-pass',
    ]) {
      const res = await c.setPassword({ password });
      expect(res.statusCode, password).toBe(422);
      expect(problem(res).code).toBe('WEAK_PASSWORD');
      expect(problem(res).errors![0]!.field).toBe('password');
    }
    const named = await c.setPassword({ password: `${staff.email.split('@')[0]}-extra` });
    expect(problem(named).code).toBe('WEAK_PASSWORD');
    expect((await staffRow(staff.id)).mustChangePassword).toBe(true);
    // The pending session is still usable after a refusal.
    expect((await c.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(204);
  });

  it('422 VALIDATION_FAILED on `password` when it is missing', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true });
    const c = consoleOf();
    await c.login(staff.email);
    const res = await c.call('POST', '/admin/auth/password/set', {});
    expect(res.statusCode).toBe(422);
    expect(problem(res).code).toBe('VALIDATION_FAILED');
    expect(problem(res).errors![0]!.field).toBe('password');
  });

  it('401 without a token and without a pending-password session; 403 CSRF_FAILED without the token', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true });
    expect((await consoleOf().setPassword({ password: NEW_PASSWORD })).statusCode).toBe(401);

    const c = consoleOf();
    await c.login(staff.email);
    const refused = await c.setPassword({ password: NEW_PASSWORD }, { csrf: false });
    expect(refused.statusCode).toBe(403);
    expect(problem(refused).code).toBe('CSRF_FAILED');
    expect((await staffRow(staff.id)).mustChangePassword).toBe(true);

    // A full session or a code-step session is not the forced change.
    const ok = await makeStaff(t);
    const full = await signedIn(ok);
    expect((await full.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(401);
    const asked = consoleOf();
    await asked.login(ok.email);
    expect((await asked.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(401);
  });

  it('403 ACCOUNT_SUSPENDED when the member was suspended since login, 401 once the session view is reloaded', async () => {
    const staff = await makeStaff(t, { mustChangePassword: true });
    const c = consoleOf();
    await c.login(staff.email);
    await c.me(); // warms the cached session view, which still says "ok" after the update below
    const { db } = await testDb();
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staff.id));
    const res = await c.setPassword({ password: NEW_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
    expect((await staffRow(staff.id)).mustChangePassword).toBe(true);
    // Every session of the account is gone now.
    expect((await c.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(401);
  });
});

describe('password set by an emailed link (token mode)', () => {
  const NEW_PASSWORD = 'a-brand-new-passphrase';

  /** Issues a link the way staff management will, in its own transaction. */
  async function issue(staffId: number, purpose: 'invite' | 'reset' = 'invite') {
    return t.app
      .get(DbService)
      .runInTransaction((work) => t.app.get(StaffAuthTokens).issue(work, { staffId, purpose }));
  }

  it('invite link → password → login → setup → code; the link works once; nothing signs in', async () => {
    const staff = await makeStaff(t, { status: 'invited', noPassword: true, twofaEnabled: false, noSecret: true });
    expect((await consoleOf().login(staff.email, 'whatever-123456')).statusCode).toBe(401);
    const { token, expiresAt } = await issue(staff.id);
    expect(Math.abs(expiresAt.getTime() - Date.now() - STAFF_TOKEN_TTL_MS)).toBeLessThan(5000);

    const c = consoleOf();
    const res = await c.setPassword({ token, password: NEW_PASSWORD }, { csrf: false });
    expect(res.statusCode).toBe(204);
    expect(res.cookies).toHaveLength(0);
    expect(await sessionsOf(staff.id)).toHaveLength(0);
    expect(await staffRow(staff.id)).toMatchObject({ status: 'invited', mustChangePassword: false });

    const { db } = await testDb();
    const [stored] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, staff.id));
    expect(stored).toMatchObject({ purpose: 'invite', subjectType: 'staff' });
    expect(stored!.usedAt).toBeInstanceOf(Date);
    expect(stored!.tokenHash).toBe(t.app.get(TokenService).hash(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const second = await c.setPassword({ token, password: 'another-long-passphrase' }, { csrf: false });
    expect(second.statusCode).toBe(410);
    expect(problem(second).code).toBe('TOKEN_INVALID');

    const login = consoleOf();
    expect((await login.login(staff.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp_setup' });
    const secret = (await login.setup()).json<{ secret: string }>().secret;
    expect((await login.code(await codeFor(secret))).statusCode).toBe(204);
    expect(await staffRow(staff.id)).toMatchObject({ status: 'active', twofaEnabled: true });
  });

  it('a reset link ends the sessions of the account', async () => {
    const staff = await makeStaff(t);
    const open = await signedIn(staff);
    const { token } = await issue(staff.id, 'reset');
    expect((await consoleOf().setPassword({ token, password: NEW_PASSWORD })).statusCode).toBe(204);
    expect((await open.me()).statusCode).toBe(401);
    expect((await consoleOf().login(staff.email, PASSWORD)).statusCode).toBe(401);
    expect((await consoleOf().login(staff.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('410 TOKEN_INVALID for an unknown, expired, superseded or suspended-account link', async () => {
    const staff = await makeStaff(t);
    const c = consoleOf();
    const bad = (token: string) => c.setPassword({ token, password: NEW_PASSWORD });
    const unknown = await bad('x'.repeat(43));
    expect(unknown.statusCode).toBe(410);
    expect(problem(unknown).code).toBe('TOKEN_INVALID');

    const old = await issue(staff.id);
    const newest = await issue(staff.id, 'reset');
    expect((await bad(old.token)).statusCode).toBe(410);

    const { db } = await testDb();
    await db
      .update(s.authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.authTokens.id, newest.id));
    expect((await bad(newest.token)).statusCode).toBe(410);

    const live = await issue(staff.id);
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staff.id));
    expect((await bad(live.token)).statusCode).toBe(410);
    expect((await staffRow(staff.id)).passwordHash).toBe(staff.row.passwordHash);
  });

  it('a link of another purpose or subject type is not a staff link', async () => {
    const staff = await makeStaff(t);
    const { db } = await testDb();
    const tokens = t.app.get(TokenService);
    const odd = tokens.random(32);
    await db.insert(s.authTokens).values({
      purpose: 'magic-link',
      subjectType: 'staff',
      subjectId: staff.id,
      tokenHash: tokens.hash(odd),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const merchant = tokens.random(32);
    await db.insert(s.authTokens).values({
      purpose: 'invite',
      subjectType: 'client',
      subjectId: staff.id,
      tokenHash: tokens.hash(merchant),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const c = consoleOf();
    expect((await c.setPassword({ token: odd, password: NEW_PASSWORD })).statusCode).toBe(410);
    expect((await c.setPassword({ token: merchant, password: NEW_PASSWORD })).statusCode).toBe(410);
  });

  it('a weak password is refused without using the link up', async () => {
    const staff = await makeStaff(t, { noPassword: true });
    const { token } = await issue(staff.id);
    const c = consoleOf();
    const weak = await c.setPassword({ token, password: 'password1234' });
    expect(weak.statusCode).toBe(422);
    expect(problem(weak).code).toBe('WEAK_PASSWORD');
    expect(problem(weak).errors![0]!.field).toBe('password');
    expect((await c.setPassword({ token, password: NEW_PASSWORD })).statusCode).toBe(204);
  });

  it('lets exactly one of two simultaneous requests with the same link win', async () => {
    const staff = await makeStaff(t);
    const { token } = await issue(staff.id);
    const results = await Promise.all(
      ['first-long-passphrase', 'second-long-passphrase'].map((password) =>
        consoleOf().setPassword({ token, password }),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 410]);
  });

  it('needs an allowed Origin (403 CSRF_FAILED), and the per-address limit on links answers 429', async () => {
    const staff = await makeStaff(t);
    const { token } = await issue(staff.id);
    const noOrigin = await consoleOf().setPassword({ token, password: NEW_PASSWORD }, { origin: false });
    expect(noOrigin.statusCode).toBe(403);
    expect(problem(noOrigin).code).toBe('CSRF_FAILED');

    const ip = freshClientIp();
    const guesser = consoleOf(ip);
    for (let i = 0; i < 30; i++)
      expect((await guesser.setPassword({ token: `x${i}`, password: NEW_PASSWORD })).statusCode).toBe(410);
    const limited = await guesser.setPassword({ token, password: NEW_PASSWORD });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a new link voids the older ones and keeps only hashes', async () => {
    const staff = await makeStaff(t);
    const first = await issue(staff.id);
    const second = await issue(staff.id, 'reset');
    const { db } = await testDb();
    const rows = await db
      .select()
      .from(s.authTokens)
      .where(eq(s.authTokens.subjectId, staff.id))
      .orderBy(asc(s.authTokens.id));
    expect(rows.map((row) => [row.id, row.purpose])).toEqual([
      [first.id, 'invite'],
      [second.id, 'reset'],
    ]);
    expect(rows[0]!.usedAt).toBeInstanceOf(Date);
    expect(rows[1]!.usedAt).toBeNull();
    expect(rows.every((row) => !row.tokenHash.includes(first.token) && row.tokenHash.length === 64)).toBe(true);
  });
});

describe('sessions of another subject', () => {
  it('a merchant cookie cannot call the staff routes', async () => {
    const { db } = await testDb();
    const { insertMerchant } = await import('../support/auth');
    const merchantId = await insertMerchant(db);
    const session = await openSession(t, { type: 'client', id: merchantId });
    const res = await t.app.inject({ method: 'GET', url: '/admin/auth/me', headers: session.headers });
    expect(res.statusCode).toBe(401);
  });

  it('SessionService sees the rotated session as a staff session', async () => {
    const staff = await makeStaff(t);
    const c = await signedIn(staff);
    const view = await t.app.get(SessionService).lookup(c.sessionToken!);
    expect(view).toMatchObject({ subjectType: 'staff', subjectId: staff.id, stage: 'active', ip: '127.0.0.1' });
  });
});

// The development seed (README "Local sign-in"): the demo staff, the loopback allow rules and the documented credentials let
// the console sign in from 127.0.0.1 with `demo-password` and the documented TOTP secret. Needs the frontend checkout.
describe.skipIf(!existsSync(demoStatePath()))('the development seed', () => {
  async function seed(): Promise<void> {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    await db.transaction((tx) => seedDevCredentials(tx, t.config));
    await t.app.get(IpRuleCache).invalidate();
    await clearIdentityCaches(t);
  }

  it('signs in as each seeded member with the documented secret, from the allowed loopback address', async () => {
    await seed();
    for (const [id, email] of [
      [1, 'rami@gsm-supply.example'],
      [2, 'lina@gsm-supply.example'],
      [3, 'omar@gsm-supply.example'],
      [4, 'dana@gsm-supply.example'],
    ] as const) {
      const c = consoleOf();
      expect((await c.login(email, DEV_PASSWORD)).json(), email).toEqual({ next: 'totp' });
      expect((await c.code(await codeFor(DEV_TOTP_SECRETS[id]!))).statusCode, email).toBe(204);
      expect((await c.me()).json<{ email: string }>().email).toBe(email);
    }
  });

  it('refuses the same sign-in from an address outside the allowlist', async () => {
    await seed();
    const res = await consoleOf('203.0.113.99').login('rami@gsm-supply.example', DEV_PASSWORD);
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('IP_NOT_ALLOWED');
  });

  it('shows the invited member the authenticator setup and the suspended one a 403, with the same password', async () => {
    await seed();
    const nadia = consoleOf();
    expect((await nadia.login('nadia@gsm-supply.example', DEV_PASSWORD)).json()).toEqual({ next: 'totp_setup' });
    const secret = (await nadia.setup()).json<{ secret: string }>().secret;
    expect((await nadia.code(await codeFor(secret))).statusCode).toBe(204);
    const yusuf = await consoleOf().login('yusuf@gsm-supply.example', DEV_PASSWORD);
    expect(yusuf.statusCode).toBe(403);
    expect(problem(yusuf).code).toBe('ACCOUNT_SUSPENDED');
  });
});
