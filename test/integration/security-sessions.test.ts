// Integration tests of SessionService, the session policy (lifetimes from settings) and the cookie helpers (decision 018):
// create, lookup and its cache, rotation, revocation, the once-a-minute touch, invalidation, transactions, Set-Cookie output.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AppError } from '../../src/common/errors';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { TokenService } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import {
  CsrfService,
  SESSION_DEFAULT_MINUTES,
  SESSION_SETTING_KEYS,
  SessionService,
  TOUCH_INTERVAL_MS,
} from '../../src/modules/identity';
import { SettingsReader } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { SECOND, TestClock } from '../support/clock';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { expectRejection, rejectionOf } from '../support/rejection';
import { SecurityTestController } from '../support/security-routes';

/** The app's clock: sessions end and the touch interval passes when the test moves it (decision 031). */
const clock = new TestClock();
let t: TestApp;
let sessions: SessionService;
let staffId: number;

beforeAll(async () => {
  t = await createTestApp({
    controllers: [SecurityTestController],
    env: { CORS_ORIGINS: 'https://console.example.com' },
    clock,
  });
  sessions = t.app.get(SessionService);
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  staffId = await insertStaff(db, await insertRole(db, ['staff:read']));
});

const input = (over: Record<string, unknown> = {}) => ({
  subjectType: 'staff' as const,
  subjectId: staffId,
  stage: 'active' as const,
  ip: '203.0.113.7',
  userAgent: 'bun-test',
  ...over,
});
const hashOf = (token: string) => t.app.get(TokenService).hash(token);
const cacheKey = (token: string) => t.app.get(CacheKeys).session(hashOf(token));
const cached = async (token: string) => (await t.app.get(RedisService).cache.exists(cacheKey(token))) === 1;
const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

describe('create', () => {
  it('stores only the keyed hash of the token, never the token', async () => {
    const { db } = await testDb();
    const { token, session } = await sessions.create(input());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.tokenHash).toBe(hashOf(token));
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db.select().from(s.sessions).where(eq(s.sessions.id, session.id));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({
      subjectType: 'staff',
      subjectId: staffId,
      stage: 'active',
      ip: '203.0.113.7',
      userAgent: 'bun-test',
      revokedAt: null,
    });
  });

  it('gives each subject and stage its lifetime from the defaults of decision 018', async () => {
    const cases = [
      ['staff', 'active', SESSION_DEFAULT_MINUTES.staffAbsolute],
      ['staff', 'pending_totp', 10],
      ['staff', 'pending_password', 10],
      ['client', 'active', 30 * 24 * 60],
      ['customer', 'active', 30 * 24 * 60],
      ['client', 'pending_totp', 10],
    ] as const;
    for (const [subjectType, stage, expected] of cases) {
      const { session } = await sessions.create(input({ subjectType, stage }));
      expect(minutes(session.createdAt, session.expiresAt), `${subjectType} ${stage}`).toBe(expected);
    }
    expect(SESSION_DEFAULT_MINUTES).toMatchObject({
      staffAbsolute: 480,
      staffIdle: 30,
      clientIdle: 10080,
      customerIdle: 10080,
      pending: 10,
    });
  });

  it('takes an explicit lifetime and cuts the user agent', async () => {
    const { session } = await sessions.create(input({ ttlSeconds: 90, userAgent: 'x'.repeat(2000) }));
    expect(Math.round((session.expiresAt.getTime() - session.createdAt.getTime()) / 1000)).toBe(90);
    expect(session.userAgent).toHaveLength(512);
  });

  it('refuses nonsense input', async () => {
    await expectRejection(
      Promise.resolve().then(() => sessions.create(input({ subjectId: 0 }))),
      RangeError,
    );
    await expectRejection(
      Promise.resolve().then(() => sessions.create(input({ ip: ' ' }))),
      RangeError,
    );
    await expectRejection(
      Promise.resolve().then(() => sessions.create(input({ ttlSeconds: 0 }))),
      RangeError,
    );
    await expectRejection(
      Promise.resolve().then(() => sessions.create(input({ ttlSeconds: 1.5 }))),
      RangeError,
    );
  });

  it('issues a different token every time', async () => {
    const a = await sessions.create(input());
    const b = await sessions.create(input());
    expect(a.token).not.toBe(b.token);
  });
});

describe('lookup', () => {
  it('returns the view with the account state and the idle limit, and caches it', async () => {
    const { token, session } = await sessions.create(input());
    expect(await cached(token)).toBe(false);
    const view = await sessions.lookup(token);
    expect(view).toMatchObject({
      id: session.id,
      tokenHash: session.tokenHash,
      subjectType: 'staff',
      subjectId: staffId,
      stage: 'active',
      idleMs: 30 * 60_000,
      lastSeenAtMs: session.lastSeenAt.getTime(),
      expiresAtMs: session.expiresAt.getTime(),
      subject: { state: 'ok' },
    });
    expect(view?.subject.roleId).toBeGreaterThan(0);
    expect(await cached(token)).toBe(true);
    expect(await sessions.lookup(token)).toEqual(view);
  });

  it('answers undefined for an unknown token and remembers that for a short time', async () => {
    const unknown = 'u'.repeat(43);
    expect(await sessions.lookup(unknown)).toBeUndefined();
    expect(await cached(unknown)).toBe(true);
  });

  it('does not touch the database or the cache for text that cannot be a token', async () => {
    for (const text of ['', 'short', 'has spaces and is long enough to pass the length check x', 'a'.repeat(200)]) {
      expect(await sessions.lookup(text)).toBeUndefined();
      expect(await cached(text)).toBe(false);
    }
  });

  it('does not find a revoked or an ended session, and a pending session has no idle limit', async () => {
    const revoked = await sessions.create(input());
    await sessions.revoke(revoked.session.id);
    expect(await sessions.lookup(revoked.token)).toBeUndefined();

    const ended = await sessions.create(input({ ttlSeconds: 60 }));
    clock.advance(60 * SECOND - 1);
    expect(await sessions.lookup(ended.token), 'a millisecond before its end').toBeDefined();
    // The view above is cached; the database is asked again after the cache is cleared.
    await t.app.get(CacheService).del(cacheKey(ended.token));
    clock.advance(1);
    expect(await sessions.lookup(ended.token), 'at its end').toBeUndefined();

    const pending = await sessions.create(input({ stage: 'pending_totp' }));
    expect((await sessions.lookup(pending.token))?.idleMs).toBe(0);
  });

  it('reports an account that does not exist as gone, a suspended one as suspended', async () => {
    const { db } = await testDb();
    const suspended = await sessions.create(input());
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staffId));
    expect((await sessions.lookup(suspended.token))?.subject.state).toBe('suspended');

    const ghost = await sessions.create(input({ subjectId: 987_654 }));
    expect(await sessions.lookup(ghost.token)).toBeUndefined();
    // Customers have no resolver in this app: their sessions are never valid.
    const customer = await sessions.create(input({ subjectType: 'customer', subjectId: 3 }));
    expect(await sessions.lookup(customer.token)).toBeUndefined();
  });
});

describe('rotate', () => {
  it('replaces the session: new token, old one revoked and gone from the cache, same account', async () => {
    const old = await sessions.create(input({ stage: 'pending_totp', userAgent: 'agent-1' }));
    const oldView = await sessions.lookup(old.token);
    expect(await cached(old.token)).toBe(true);

    const fresh = await sessions.rotate(oldView!, { stage: 'active' });
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.session).toMatchObject({
      subjectType: 'staff',
      subjectId: staffId,
      stage: 'active',
      ip: '203.0.113.7',
      userAgent: 'agent-1',
      revokedAt: null,
    });
    // A full staff session gets the full lifetime; the pending one had ten minutes.
    expect(minutes(fresh.session.createdAt, fresh.session.expiresAt)).toBe(480);

    expect(await cached(old.token)).toBe(false);
    expect(await sessions.lookup(old.token)).toBeUndefined();
    expect((await sessions.lookup(fresh.token))?.stage).toBe('active');
  });

  it('changes the CSRF token with the session', async () => {
    const csrf = t.app.get(CsrfService);
    const old = await sessions.create(input({ stage: 'pending_totp' }));
    const fresh = await sessions.rotate({ id: old.session.id }, { stage: 'active' });
    expect(csrf.tokenFor(fresh.session.tokenHash)).not.toBe(csrf.tokenFor(old.session.tokenHash));
    expect(csrf.matches(fresh.session.tokenHash, csrf.tokenFor(old.session.tokenHash))).toBe(false);
  });

  it('can change the IP and the lifetime', async () => {
    const old = await sessions.create(input());
    const fresh = await sessions.rotate(
      { id: old.session.id },
      { stage: 'active', ip: '198.51.100.4', ttlSeconds: 120 },
    );
    expect(fresh.session.ip).toBe('198.51.100.4');
    expect(Math.round((fresh.session.expiresAt.getTime() - fresh.session.createdAt.getTime()) / 1000)).toBe(120);
  });

  it('refuses to rotate a session that is revoked, ended or unknown (401), and only one of two racing rotations wins', async () => {
    const { db } = await testDb();
    const revoked = await sessions.create(input());
    await sessions.revoke(revoked.session.id);
    const error = await rejectionOf(sessions.rotate({ id: revoked.session.id }, { stage: 'active' }));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNAUTHORIZED');

    const ended = await sessions.create(input({ ttlSeconds: 1 }));
    clock.advance(SECOND);
    await expectRejection(sessions.rotate({ id: ended.session.id }, { stage: 'active' }), AppError);
    await expectRejection(sessions.rotate({ id: 99_999_999 }, { stage: 'active' }), AppError);

    const race = await sessions.create(input({ stage: 'pending_totp' }));
    const results = await Promise.allSettled([
      sessions.rotate({ id: race.session.id }, { stage: 'active' }),
      sessions.rotate({ id: race.session.id }, { stage: 'active' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const live = await db.select().from(s.sessions).where(eq(s.sessions.subjectId, staffId));
    expect(
      live.filter((row) => row.stage === 'active' && row.revokedAt === null && row.id !== ended.session.id),
    ).toHaveLength(1);
  });
});

describe('revoke', () => {
  it('ends one session, once, and the cached view goes with it', async () => {
    const one = await sessions.create(input());
    const other = await sessions.create(input());
    await sessions.lookup(one.token);
    expect(await sessions.revoke(one.session.id)).toBe(true);
    expect(await sessions.revoke(one.session.id)).toBe(false);
    expect(await cached(one.token)).toBe(false);
    expect(await sessions.lookup(one.token)).toBeUndefined();
    expect(await sessions.lookup(other.token)).toBeDefined();
  });

  it('ends every session of an account except the one to keep, and leaves other accounts alone', async () => {
    const { db } = await testDb();
    const keep = await sessions.create(input());
    const a = await sessions.create(input());
    const b = await sessions.create(input({ stage: 'pending_totp' }));
    const otherStaff = await insertStaff(db, await insertRole(db, []));
    const stranger = await sessions.create(input({ subjectId: otherStaff }));
    for (const issued of [keep, a, b, stranger]) await sessions.lookup(issued.token);

    expect(await sessions.revokeAllOf('staff', staffId, { exceptSessionId: keep.session.id })).toBe(2);
    expect(await sessions.lookup(keep.token)).toBeDefined();
    expect(await sessions.lookup(a.token)).toBeUndefined();
    expect(await sessions.lookup(b.token)).toBeUndefined();
    expect(await sessions.lookup(stranger.token)).toBeDefined();
    expect(await sessions.revokeAllOf('staff', staffId)).toBe(1);
    expect(await sessions.revokeAllOf('staff', staffId)).toBe(0);
    // The same id under another subject type is another account.
    const merchant = await sessions.create(input({ subjectType: 'client', subjectId: staffId }));
    expect(await sessions.revokeAllOf('staff', staffId)).toBe(0);
    expect(merchant.session.revokedAt).toBeNull();
  });
});

describe('touch', () => {
  it('writes last_seen_at only when the stored value is a minute old, and drops the cached view', async () => {
    const { db } = await testDb();
    const { token, session } = await sessions.create(input());
    const view = (await sessions.lookup(token))!;
    expect(await sessions.touch(view)).toBe(false);
    clock.advance(TOUCH_INTERVAL_MS - 1);
    expect(await sessions.touch(view)).toBe(false);

    clock.advance(6);
    const later = clock.nowMs();
    expect(later).toBe(view.lastSeenAtMs + TOUCH_INTERVAL_MS + 5);
    expect(await sessions.touch(view)).toBe(true);
    const [row] = await db.select().from(s.sessions).where(eq(s.sessions.id, session.id));
    expect(row!.lastSeenAt.getTime()).toBe(later);
    expect(await cached(token)).toBe(false);
    expect((await sessions.lookup(token))?.lastSeenAtMs).toBe(later);
    // A second instance with the same stale view writes nothing (the database guard sees a fresh value), but it drops the
    // stale cached view all the same, so the next lookup carries the time that was written.
    await sessions.lookup(token);
    expect(await cached(token)).toBe(true);
    clock.advance(10);
    expect(await sessions.touch(view)).toBe(false);
    expect(await cached(token)).toBe(false);
  });

  it('does not resurrect a revoked session', async () => {
    const { token, session } = await sessions.create(input());
    const view = (await sessions.lookup(token))!;
    await sessions.revoke(session.id);
    clock.advance(10 * TOUCH_INTERVAL_MS);
    expect(await sessions.touch(view)).toBe(false);
  });
});

describe('invalidateSubject', () => {
  it('drops the cached views of the account so a changed status is read again', async () => {
    const { db } = await testDb();
    const a = await sessions.create(input());
    const b = await sessions.create(input());
    expect((await sessions.lookup(a.token))?.subject.state).toBe('ok');
    await sessions.lookup(b.token);
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staffId));
    // Still the old state: the view is cached for 60 seconds.
    expect((await sessions.lookup(a.token))?.subject.state).toBe('ok');
    await sessions.invalidateSubject('staff', staffId);
    expect(await cached(a.token)).toBe(false);
    expect(await cached(b.token)).toBe(false);
    expect((await sessions.lookup(a.token))?.subject.state).toBe('suspended');
  });
});

describe("inside the caller's transaction", () => {
  it('rolls back with it: nothing is revoked and the cache keeps the view', async () => {
    const db = t.app.get(DbService);
    const { token, session } = await sessions.create(input());
    await sessions.lookup(token);
    await expectRejection(
      db.runInTransaction(async (work) => {
        expect(await sessions.revokeAllOf('staff', staffId, {}, work)).toBe(1);
        throw new Error('the use case failed');
      }),
      /use case failed/,
    );
    const [row] = await (await testDb()).db.select().from(s.sessions).where(eq(s.sessions.id, session.id));
    expect(row!.revokedAt).toBeNull();
    expect(await cached(token)).toBe(true);
  });

  it('cleans the cache only after the commit', async () => {
    const db = t.app.get(DbService);
    const { token } = await sessions.create(input());
    await sessions.lookup(token);
    await db.runInTransaction(async (work) => {
      await sessions.revokeAllOf('staff', staffId, {}, work);
      // Still cached while the transaction is open (a reader must not re-cache a pre-commit state).
      expect(await cached(token)).toBe(true);
    });
    expect(await cached(token)).toBe(false);
    expect(await sessions.lookup(token)).toBeUndefined();
  });

  it('creates and rotates inside it too', async () => {
    const db = t.app.get(DbService);
    const out = await db.runInTransaction(async (work) => {
      const first = await sessions.create(input({ stage: 'pending_totp' }), work);
      const second = await sessions.rotate({ id: first.session.id }, { stage: 'active' }, work);
      return { first, second };
    });
    expect(await sessions.lookup(out.first.token)).toBeUndefined();
    expect((await sessions.lookup(out.second.token))?.stage).toBe('active');
    const rolledBack = await rejectionOf(
      db.runInTransaction(async (work) => {
        await sessions.create(input({ ttlSeconds: 77 }), work);
        throw new Error('rollback');
      }),
    );
    expect((rolledBack as Error).message).toBe('rollback');
    const rows = await (await testDb()).db.select().from(s.sessions);
    expect(rows.some((row) => Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 1000) === 77)).toBe(
      false,
    );
  });
});

describe('lifetimes from settings', () => {
  const setSetting = async (key: string, value: unknown) => {
    const { db } = await testDb();
    await db.insert(s.settings).values({ key, value }).onConflictDoUpdate({ target: s.settings.key, set: { value } });
    await t.app.get(SettingsReader).invalidate();
  };

  it('uses the staff lifetime and idle limit that the settings give', async () => {
    await setSetting(SESSION_SETTING_KEYS.staffAbsolute, 5);
    await setSetting(SESSION_SETTING_KEYS.staffIdle, 2);
    const { token, session } = await sessions.create(input());
    expect(minutes(session.createdAt, session.expiresAt)).toBe(5);
    expect((await sessions.lookup(token))?.idleMs).toBe(2 * 60_000);
  });

  it('uses the pending lifetime for sign-in steps and the merchant lifetimes for merchants', async () => {
    const { db } = await testDb();
    await setSetting(SESSION_SETTING_KEYS.pending, 3);
    await setSetting(SESSION_SETTING_KEYS.clientAbsolute, 60);
    await setSetting(SESSION_SETTING_KEYS.clientIdle, 15);
    const pending = await sessions.create(input({ stage: 'pending_totp' }));
    expect(minutes(pending.session.createdAt, pending.session.expiresAt)).toBe(3);
    const merchant = await sessions.create(input({ subjectType: 'client', subjectId: await insertMerchant(db) }));
    expect(minutes(merchant.session.createdAt, merchant.session.expiresAt)).toBe(60);
    expect((await sessions.lookup(merchant.token))?.idleMs).toBe(15 * 60_000);
  });

  it('falls back to the default for a value that is not a sensible whole number', async () => {
    for (const bad of [-5, 0, 1.5, 'eight hours', true, [8], 99_999_999]) {
      await setSetting(SESSION_SETTING_KEYS.staffAbsolute, bad);
      const { session } = await sessions.create(input());
      expect(minutes(session.createdAt, session.expiresAt), JSON.stringify(bad)).toBe(480);
    }
  });
});

describe('cookies', () => {
  const issue = () =>
    t.app.inject({ method: 'POST', url: '/admin/t/sec/issue', headers: { origin: 'https://console.example.com' } });

  it('sets the httpOnly session cookie, the readable CSRF cookie and the X-CSRF-Token header', async () => {
    const res = await issue();
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies;
    const session = cookies.find((cookie) => cookie.name === 'gsm_admin_session')!;
    const csrf = cookies.find((cookie) => cookie.name === 'csrf_token')!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(session.secure).toBeUndefined();
    expect(session.domain).toBeUndefined();
    expect(session.maxAge).toBeGreaterThan(500);
    expect(session.maxAge).toBeLessThanOrEqual(600);
    expect(csrf.httpOnly).toBeUndefined();
    expect(csrf).toMatchObject({ sameSite: 'Lax', path: '/' });
    expect(csrf.maxAge).toBe(session.maxAge);
    expect(res.headers['x-csrf-token']).toBe(csrf.value);
    // The CSRF token is the HMAC of the stored hash of this very token.
    expect(csrf.value).toBe(t.app.get(CsrfService).tokenFor(hashOf(session.value)));
    expect((await sessions.lookup(session.value))?.stage).toBe('pending_totp');
  });

  it('clears both cookies on sign-out', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/t/sec/clear',
      headers: { origin: 'https://console.example.com' },
    });
    expect(res.statusCode).toBe(204);
    const byName = Object.fromEntries(res.cookies.map((cookie) => [cookie.name, cookie]));
    expect(byName.gsm_admin_session).toMatchObject({ value: '', maxAge: 0, httpOnly: true, path: '/' });
    expect(byName.csrf_token).toMatchObject({ value: '', maxAge: 0, path: '/' });
  });

  it('puts the configured domain on the CSRF cookie only', async () => {
    const withDomain = await createTestApp({
      controllers: [SecurityTestController],
      env: { CORS_ORIGINS: 'https://console.example.com', CSRF_COOKIE_DOMAIN: 'example.com' },
    });
    try {
      const res = await withDomain.app.inject({
        method: 'POST',
        url: '/admin/t/sec/issue',
        headers: { origin: 'https://console.example.com' },
      });
      const byName = Object.fromEntries(res.cookies.map((cookie) => [cookie.name, cookie]));
      expect(byName.csrf_token?.domain).toBe('example.com');
      expect(byName.gsm_admin_session?.domain).toBeUndefined();
    } finally {
      await withDomain.close();
    }
  });
});

describe('the cache is a pure optimisation', () => {
  it('keeps working when the cache entry is gone', async () => {
    const { token } = await sessions.create(input());
    const first = await sessions.lookup(token);
    await t.app.get(CacheService).del(cacheKey(token));
    expect(await sessions.lookup(token)).toEqual(first);
  });
});
