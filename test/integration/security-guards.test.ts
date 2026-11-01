// Integration tests of the session guards and the dispatcher (decision 018) through real HTTP: staff, merchant and customer
// sessions (accept and refuse cases, expiry, pending stages, suspension), permissions, CSRF and the Origin check, and the
// machine kinds that no longer fall back to a placeholder. Real Postgres and Redis; sessions are made by the real SessionService.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import {
  AccessHandlers,
  RolePermissions,
  SessionAuthenticator,
  SessionService,
  SessionSubjects,
  type SessionSubjectResolver,
} from '../../src/modules/identity';
import { ACCESS_KINDS } from '../../src/common/contract';
import { type TestApp, createTestApp } from '../support/app';
import {
  clearIdentityCaches,
  insertMerchant,
  insertRole,
  insertStaff,
  openSession,
  sessionOf,
  signInStaff,
} from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { expectRejection } from '../support/rejection';
import { TestController } from '../support/routes';
import { PLACEHOLDER_URLS, SecurityTestController } from '../support/security-routes';

const CONSOLE = 'https://console.example.com';
let t: TestApp;
let customers: Map<number, 'ok' | 'suspended' | 'gone'>;

beforeAll(async () => {
  t = await createTestApp({
    controllers: [SecurityTestController, TestController],
    env: { CORS_ORIGINS: CONSOLE },
  });
  // The customers module registers its resolver when its feature is built; the test stands in for it.
  customers = new Map();
  const resolver: SessionSubjectResolver = {
    subjectType: 'customer',
    resolve: (id) => Promise.resolve({ state: customers.get(id) ?? 'gone' }),
  };
  t.app.get(SessionSubjects).register(resolver);
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  customers.clear();
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'POST', url, headers });

describe('staff session guard', () => {
  it('accepts an active session and hands the handler the principal', async () => {
    const { session, staffId } = await signInStaff(t, []);
    const res = await get('/admin/t/sec/session', session.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, kind: 'staff', id: staffId, stage: 'active' });
  });

  it('refuses a request without a cookie, with a garbage cookie and with an unknown token as 401 problem+json', async () => {
    const cookieName = 'gsm_admin_session';
    for (const headers of [
      {} as Record<string, string>,
      { cookie: `${cookieName}=` },
      { cookie: `${cookieName}=not-a-token` },
      { cookie: `${cookieName}=${'a'.repeat(43)}` },
    ]) {
      const res = await get('/admin/t/sec/session', headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401, requestId: res.headers['x-request-id'] });
    }
  });

  it('refuses a revoked session at once, although its lookup was cached', async () => {
    const { session } = await signInStaff(t, []);
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    await t.app.get(SessionService).revoke(session.sessionId);
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(401);
  });

  it('refuses a session past its absolute end, and one idle for longer than the staff idle limit', async () => {
    const { db } = await testDb();
    const { session } = await signInStaff(t, []);
    const key = () => t.app.get(CacheKeys).session(t.app.get(TokenService).hash(session.token));

    await db
      .update(s.sessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(s.sessions.id, session.sessionId));
    await t.app.get(CacheService).del(key());
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(401);

    const idle = await signInStaff(t, []);
    await db
      .update(s.sessions)
      .set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(s.sessions.id, idle.session.sessionId));
    await t.app.get(CacheService).del(t.app.get(CacheKeys).session(t.app.get(TokenService).hash(idle.session.token)));
    expect((await get('/admin/t/sec/session', idle.session.headers)).statusCode).toBe(401);

    const recent = await signInStaff(t, []);
    await db
      .update(s.sessions)
      .set({ lastSeenAt: new Date(Date.now() - 29 * 60_000) })
      .where(eq(s.sessions.id, recent.session.sessionId));
    await t.app.get(CacheService).del(t.app.get(CacheKeys).session(t.app.get(TokenService).hash(recent.session.token)));
    expect((await get('/admin/t/sec/session', recent.session.headers)).statusCode).toBe(200);
  });

  it('judges a cached view again on every request: an ended session is refused before its cache entry expires', async () => {
    const { staffId } = await signInStaff(t, []);
    // 4 s: under a loaded full-suite run the first request can take well over a second (2 s was flaky).
    const short = await openSession(t, { type: 'staff', id: staffId }, { ttlSeconds: 4 });
    expect((await get('/admin/t/sec/session', short.headers)).statusCode).toBe(200);
    await Bun.sleep(4_200);
    // The view is still in the cache (60 seconds), but its absolute end has passed.
    expect((await get('/admin/t/sec/session', short.headers)).statusCode).toBe(401);
  });

  it('refuses a pending session on a normal route, accepts it only on the step that declares its stage', async () => {
    const { staffId } = await signInStaff(t, []);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_totp' });
    expect((await get('/admin/t/sec/session', pending.headers)).statusCode).toBe(401);
    expect((await get('/admin/t/sec/needs-read', pending.headers)).statusCode).toBe(401);

    const step = await post('/admin/t/sec/step', pending.mutationHeaders);
    expect(step.statusCode).toBe(200);
    expect(step.json()).toMatchObject({ kind: 'staff', id: staffId, stage: 'pending_totp' });

    const setup = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_totp_setup' });
    expect((await post('/admin/t/sec/step', setup.mutationHeaders)).statusCode).toBe(200);
    const password = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_password' });
    expect((await post('/admin/t/sec/step', password.mutationHeaders)).statusCode).toBe(401);
    expect((await post('/admin/t/sec/any-stage', password.mutationHeaders)).statusCode).toBe(200);
  });

  it('refuses a full session on a sign-in step that only accepts pending stages', async () => {
    const { session } = await signInStaff(t, ['*']);
    expect((await post('/admin/t/sec/step', session.mutationHeaders)).statusCode).toBe(401);
    expect((await post('/admin/t/sec/any-stage', session.mutationHeaders)).statusCode).toBe(200);
  });

  it('hands a handler the staff principal with the permissions of the role, and refuses a handler that asks for staff on another route', async () => {
    const { session, staffId, roleId } = await signInStaff(t, ['orders:read', 'staff:*']);
    expect((await get('/admin/t/sec/who', session.headers)).json()).toEqual({
      staffId,
      roleId,
      permissions: ['orders:read', 'staff:*'],
    });
    const { db } = await testDb();
    const merchant = await openSession(t, { type: 'client', id: await insertMerchant(db) });
    expect((await get('/client/t/sec/as-staff', merchant.headers)).statusCode).toBe(401);
  });

  it('gives a pending principal no permissions, even when the role holds them', async () => {
    const { staffId } = await signInStaff(t, ['*']);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_totp' });
    // The permission route needs an active session; the pending one never reaches the permission check.
    expect((await get('/admin/t/sec/needs-read', pending.headers)).statusCode).toBe(401);
  });

  it('refuses a suspended staff member with 403 ACCOUNT_SUSPENDED and revokes every session of the account', async () => {
    const { db } = await testDb();
    const { session, staffId } = await signInStaff(t, ['*']);
    const second = await openSession(t, { type: 'staff', id: staffId });
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);

    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staffId));
    await t.app.get(SessionService).invalidateSubject('staff', staffId);

    const refused = await get('/admin/t/sec/session', session.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    const rows = await db.select().from(s.sessions).where(eq(s.sessions.subjectId, staffId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    // The other device is signed out too; its next request is a plain 401.
    expect((await get('/admin/t/sec/session', second.headers)).statusCode).toBe(401);
  });

  it('lets an invited staff member through a pending sign-in step (the first sign-in)', async () => {
    const { db } = await testDb();
    const roleId = await insertRole(db, ['staff:read']);
    const staffId = await insertStaff(db, roleId, { status: 'invited' });
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_totp_setup' });
    expect((await post('/admin/t/sec/step', pending.mutationHeaders)).statusCode).toBe(200);
  });

  it('refuses a session whose staff member does not exist any more', async () => {
    const { db } = await testDb();
    const roleId = await insertRole(db, []);
    const staffId = await insertStaff(db, roleId);
    const session = await openSession(t, { type: 'staff', id: staffId });
    await db.delete(s.sessions).where(eq(s.sessions.id, session.sessionId));
    await db.delete(s.staffUsers).where(eq(s.staffUsers.id, staffId));
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(401);
  });

  it('does not accept a merchant session token as a staff cookie', async () => {
    const { db } = await testDb();
    const merchantId = await insertMerchant(db);
    const merchant = await openSession(t, { type: 'client', id: merchantId });
    const asStaffCookie = sessionOf(t, 'staff', merchant.token);
    expect((await get('/admin/t/sec/session', asStaffCookie.headers)).statusCode).toBe(401);
  });

  it('touches last_seen_at at most once a minute', async () => {
    const { db } = await testDb();
    const { session } = await signInStaff(t, []);
    const seenAt = async () =>
      (await db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)))[0]!.lastSeenAt.getTime();
    const created = await seenAt();
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    expect(await seenAt()).toBe(created);

    const old = Date.now() - 5 * 60_000;
    await db
      .update(s.sessions)
      .set({ lastSeenAt: new Date(old) })
      .where(eq(s.sessions.id, session.sessionId));
    await t.app.get(CacheService).del(t.app.get(CacheKeys).session(t.app.get(TokenService).hash(session.token)));
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    const touched = await seenAt();
    expect(touched).toBeGreaterThan(old + 4 * 60_000);
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    expect(await seenAt()).toBe(touched);
  });
});

describe('permission guard', () => {
  const read = (session: { headers: Record<string, string> }) => get('/admin/t/sec/needs-read', session.headers);

  it('lets a role through that holds the permission, the area wildcard, * or *:*', async () => {
    for (const permissions of [['staff:read'], ['staff:*'], ['*'], ['*:*'], ['orders:read', 'staff:read']]) {
      const { session } = await signInStaff(t, permissions);
      expect((await read(session)).statusCode, permissions.join()).toBe(200);
    }
  });

  it('answers 403 FORBIDDEN naming the missing permission, and does not sign the caller out', async () => {
    const { session } = await signInStaff(t, ['orders:*', 'staff:update', 'stafff:read']);
    const refused = await read(session);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You need the staff:read permission to do this.',
    });
    // The session is still good for the routes the role allows.
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
  });

  it('applies the required x:* rule: a literal risk:* needs risk:* or *, not risk:read', async () => {
    const put = (session: { mutationHeaders: Record<string, string> }) =>
      t.app.inject({ method: 'PUT', url: '/admin/t/sec/risk-rules', headers: session.mutationHeaders });
    expect((await put((await signInStaff(t, ['risk:read'])).session)).statusCode).toBe(403);
    expect((await put((await signInStaff(t, ['risk:update', 'risk:create'])).session)).statusCode).toBe(403);
    expect((await put((await signInStaff(t, ['risk:*'])).session)).statusCode).toBe(200);
    expect((await put((await signInStaff(t, ['*'])).session)).statusCode).toBe(200);
  });

  it('refuses a role that no longer exists in the sense of an empty permission list', async () => {
    const { session } = await signInStaff(t, []);
    expect((await read(session)).statusCode).toBe(403);
  });

  it('applies a role change on the next request once the role cache is invalidated', async () => {
    const { db } = await testDb();
    const { session, roleId } = await signInStaff(t, ['staff:read']);
    expect((await read(session)).statusCode).toBe(200);

    await db
      .update(s.roles)
      .set({ permissions: ['orders:read'] })
      .where(eq(s.roles.id, roleId));
    // Until the role routes invalidate the cache, the old permissions are still served (cached per role, 5 minutes).
    expect((await read(session)).statusCode).toBe(200);
    await t.app.get(RolePermissions).invalidate(roleId);
    expect((await read(session)).statusCode).toBe(403);
  });

  it('applies a change of the staff member to another role once the session views are invalidated', async () => {
    const { db } = await testDb();
    const { session, staffId } = await signInStaff(t, ['staff:read']);
    expect((await read(session)).statusCode).toBe(200);
    const other = await insertRole(db, ['orders:read']);
    await db.update(s.staffUsers).set({ roleId: other }).where(eq(s.staffUsers.id, staffId));
    await t.app.get(SessionService).invalidateSubject('staff', staffId);
    expect((await read(session)).statusCode).toBe(403);
  });
});

describe('CSRF guard', () => {
  it('lets a GET through without the token', async () => {
    const { session } = await signInStaff(t, []);
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
  });

  it("refuses a mutation without the header, with a wrong token and with another session's token", async () => {
    const { session, staffId } = await signInStaff(t, ['staff:update']);
    const other = await openSession(t, { type: 'staff', id: staffId });
    const missing = await post('/admin/t/sec/write', session.headers);
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'CSRF_FAILED', status: 403 });
    expect(missing.json().detail).toContain('missing');

    for (const token of ['wrong', session.csrf.slice(1), `${session.csrf}0`, other.csrf]) {
      const res = await post('/admin/t/sec/write', { ...session.headers, 'x-csrf-token': token });
      expect(res.statusCode, token).toBe(403);
      expect(res.json().code).toBe('CSRF_FAILED');
    }
  });

  it('lets a mutation through with its own token', async () => {
    const { session } = await signInStaff(t, ['staff:update']);
    expect((await post('/admin/t/sec/write', session.mutationHeaders)).statusCode).toBe(201);
  });

  it('does not sign the caller out: the same session still works after a CSRF refusal', async () => {
    const { session } = await signInStaff(t, ['staff:update']);
    expect((await post('/admin/t/sec/write', session.headers)).statusCode).toBe(403);
    expect((await get('/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    expect((await post('/admin/t/sec/write', session.mutationHeaders)).statusCode).toBe(201);
  });

  it('checks authentication before CSRF: no session is a 401, not a 403', async () => {
    const res = await post('/admin/t/sec/write', { 'x-csrf-token': 'anything' });
    expect(res.statusCode).toBe(401);
  });

  it('checks CSRF before the permission: a caller without the permission and without the token is told about the token', async () => {
    const { session } = await signInStaff(t, []);
    expect((await post('/admin/t/sec/write', session.headers)).json().code).toBe('CSRF_FAILED');
    expect((await post('/admin/t/sec/write', session.mutationHeaders)).json().code).toBe('FORBIDDEN');
  });

  it('applies to merchants and customers too', async () => {
    const { db } = await testDb();
    const merchant = await openSession(t, { type: 'client', id: await insertMerchant(db) });
    expect((await post('/client/t/sec/write', merchant.headers)).json().code).toBe('CSRF_FAILED');
    expect((await post('/client/t/sec/write', merchant.mutationHeaders)).statusCode).toBe(200);
    customers.set(5, 'ok');
    const customer = await openSession(t, { type: 'customer', id: 5 });
    expect((await post('/store/v1/t/sec/write', customer.headers)).json().code).toBe('CSRF_FAILED');
    expect((await post('/store/v1/t/sec/write', customer.mutationHeaders)).statusCode).toBe(200);
  });
});

describe('Origin check of session-less mutations', () => {
  it('requires an Origin from CORS_ORIGINS on /admin and /client', async () => {
    for (const url of ['/admin/t/sec/login', '/client/t/sec/register']) {
      const missing = await post(url);
      expect(missing.statusCode, url).toBe(403);
      expect(missing.json().code).toBe('CSRF_FAILED');
      expect((await post(url, { origin: 'https://evil.example.com' })).json().code).toBe('CSRF_FAILED');
      expect((await post(url, { origin: 'null' })).json().code).toBe('CSRF_FAILED');
      expect((await post(url, { origin: `${CONSOLE}.evil.example.com` })).json().code).toBe('CSRF_FAILED');
      expect((await post(url, { origin: CONSOLE })).statusCode, url).toBe(200);
    }
  });

  it('does not ignore a stale session cookie or token on a session-less route', async () => {
    const { session } = await signInStaff(t, []);
    // A session-less route ignores the cookie: the Origin is what is checked, not the (missing) CSRF header.
    expect((await post('/admin/t/sec/login', { ...session.headers, origin: CONSOLE })).statusCode).toBe(200);
    expect(
      (await post('/admin/t/sec/login', { ...session.headers, 'x-csrf-token': 'stale', origin: CONSOLE })).statusCode,
    ).toBe(200);
  });

  it('does not apply to GETs, to the storefront or to other surfaces', async () => {
    expect((await get('/admin/t/sec/public')).statusCode).toBe(200);
    expect((await post('/store/v1/t/sec/public')).statusCode).toBe(200);
    expect((await post('/t/items', {})).statusCode).not.toBe(403);
  });

  it('refuses everything when no origin is configured', async () => {
    const closed = await createTestApp({ controllers: [SecurityTestController] });
    try {
      expect(
        (await closed.app.inject({ method: 'POST', url: '/admin/t/sec/login', headers: { origin: CONSOLE } }))
          .statusCode,
      ).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe('merchant session guard', () => {
  it('accepts an active merchant, including one that is still pending approval', async () => {
    const { db } = await testDb();
    for (const status of ['active', 'pending'] as const) {
      const id = await insertMerchant(db, { status });
      const res = await get('/client/t/sec/session', (await openSession(t, { type: 'client', id })).headers);
      expect(res.statusCode, status).toBe(200);
      expect(res.json()).toEqual({ ok: true, kind: 'merchant', id, stage: 'active' });
    }
  });

  it('refuses a suspended merchant with 403 ACCOUNT_SUSPENDED and revokes their sessions', async () => {
    const { db } = await testDb();
    const id = await insertMerchant(db, { status: 'suspended' });
    const session = await openSession(t, { type: 'client', id });
    const refused = await get('/client/t/sec/session', session.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('ACCOUNT_SUSPENDED');
    const rows = await db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId));
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it('keeps a merchant out of the console and a staff member out of the portal', async () => {
    const { db } = await testDb();
    const merchant = await openSession(t, { type: 'client', id: await insertMerchant(db) });
    expect((await get('/admin/t/sec/session', merchant.headers)).statusCode).toBe(401);
    const { session } = await signInStaff(t, ['*']);
    expect((await get('/client/t/sec/session', session.headers)).statusCode).toBe(401);
  });

  it('uses the merchant idle limit of seven days', async () => {
    const { db } = await testDb();
    const session = await openSession(t, { type: 'client', id: await insertMerchant(db) });
    const forget = () =>
      t.app.get(CacheService).del(t.app.get(CacheKeys).session(t.app.get(TokenService).hash(session.token)));
    await db
      .update(s.sessions)
      .set({ lastSeenAt: new Date(Date.now() - 6 * 24 * 3_600_000) })
      .where(eq(s.sessions.id, session.sessionId));
    await forget();
    expect((await get('/client/t/sec/session', session.headers)).statusCode).toBe(200);
    await db
      .update(s.sessions)
      .set({ lastSeenAt: new Date(Date.now() - 8 * 24 * 3_600_000) })
      .where(eq(s.sessions.id, session.sessionId));
    await forget();
    expect((await get('/client/t/sec/session', session.headers)).statusCode).toBe(401);
  });
});

describe('customer session guard', () => {
  it('accepts an active customer and refuses suspended and unknown ones', async () => {
    customers.set(11, 'ok');
    customers.set(12, 'suspended');
    const ok = await openSession(t, { type: 'customer', id: 11 });
    const res = await get('/store/v1/t/sec/session', ok.headers);
    expect(res.json()).toEqual({ ok: true, kind: 'customer', id: 11, stage: 'active' });

    const suspended = await openSession(t, { type: 'customer', id: 12 });
    const refused = await get('/store/v1/t/sec/session', suspended.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('ACCOUNT_SUSPENDED');

    const gone = await openSession(t, { type: 'customer', id: 13 });
    expect((await get('/store/v1/t/sec/session', gone.headers)).statusCode).toBe(401);
  });

  it('refuses every customer session while no resolver is registered (fail closed)', async () => {
    const bare = await createTestApp({ controllers: [SecurityTestController] });
    try {
      expect(bare.app.get(SessionSubjects).has('customer')).toBe(false);
      const session = await openSession(bare, { type: 'customer', id: 1 });
      expect(
        (await bare.app.inject({ method: 'GET', url: '/store/v1/t/sec/session', headers: session.headers })).statusCode,
      ).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it('refuses a second resolver for the same subject type', () => {
    expect(() =>
      t.app.get(SessionSubjects).register({ subjectType: 'staff', resolve: () => Promise.resolve({ state: 'ok' }) }),
    ).toThrow(/already registered/);
  });
});

describe('the order of the pipeline (decision 018)', () => {
  const body = (payload: unknown, headers: Record<string, string>) =>
    t.app.inject({ method: 'POST', url: '/admin/t/sec/validated', headers, payload: payload as never });

  it('authenticates before it checks CSRF, the permission or the body', async () => {
    const res = await body({ name: '' }, { 'x-csrf-token': 'wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('checks CSRF before the permission and the body', async () => {
    const { session } = await signInStaff(t, []);
    expect((await body({ name: '' }, session.headers)).json().code).toBe('CSRF_FAILED');
  });

  it('checks the permission before the body', async () => {
    const { session } = await signInStaff(t, []);
    expect((await body({ name: '' }, session.mutationHeaders)).json().code).toBe('FORBIDDEN');
  });

  it('validates the body last, and runs the handler for a request that passed everything', async () => {
    const { session } = await signInStaff(t, ['staff:update']);
    const invalid = await body({ name: '' }, session.mutationHeaders);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe('VALIDATION_FAILED');
    expect((await body({ name: 'Rami' }, session.mutationHeaders)).statusCode).toBe(201);
  });
});

describe('refusals are readable by a console on another origin', () => {
  it('carry the CORS headers, so a 401 is not mistaken for a network error', async () => {
    for (const [method, url] of [
      ['GET', '/admin/t/sec/session'],
      ['POST', '/admin/t/sec/write'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: { origin: CONSOLE } });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers.vary).toLowerCase()).toContain('origin');
    }
  });
});

describe('the CORS preflight', () => {
  it('is answered before the guards: no session and no CSRF token are needed to ask for permission', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/admin/t/sec/write',
      headers: {
        origin: CONSOLE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-csrf-token');
  });
});

describe('SessionAuthenticator.authenticateOptional (routes that serve two kinds of callers)', () => {
  const requestWith = (cookies: Record<string, string>) =>
    ({ cookies, ip: '203.0.113.7' }) as unknown as FastifyRequest;
  const stages = { stages: ['pending_password'] as const };

  it('returns the session when the request carries a usable one, otherwise nothing', async () => {
    const authenticator = t.app.get(SessionAuthenticator);
    const { staffId } = await signInStaff(t, ['staff:read']);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_password' });
    const ok = await authenticator.authenticateOptional(
      'staff',
      requestWith({ gsm_admin_session: pending.token }),
      stages,
    );
    expect(ok?.principal).toMatchObject({ kind: 'staff', staffId, stage: 'pending_password', permissions: [] });
    expect(ok?.view.id).toBe(pending.sessionId);

    expect(await authenticator.authenticateOptional('staff', requestWith({}), stages)).toBeUndefined();
    expect(
      await authenticator.authenticateOptional('staff', requestWith({ gsm_admin_session: 'junk' }), stages),
    ).toBeUndefined();
    // A full session is not the stage this caller asked for.
    const full = await openSession(t, { type: 'staff', id: staffId });
    expect(
      await authenticator.authenticateOptional('staff', requestWith({ gsm_admin_session: full.token }), stages),
    ).toBeUndefined();
  });

  it('treats a suspended account like no session, but still ends its sessions', async () => {
    const { db } = await testDb();
    const authenticator = t.app.get(SessionAuthenticator);
    const { staffId } = await signInStaff(t, []);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_password' });
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, staffId));
    await t.app.get(SessionService).invalidateSubject('staff', staffId);
    expect(
      await authenticator.authenticateOptional('staff', requestWith({ gsm_admin_session: pending.token }), stages),
    ).toBeUndefined();
    const [row] = await db.select().from(s.sessions).where(eq(s.sessions.id, pending.sessionId));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('does not hide a failure that is not about the session', async () => {
    const authenticator = t.app.get(SessionAuthenticator);
    const { staffId } = await signInStaff(t, []);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_password' });
    const broken = {
      cookies: { gsm_admin_session: pending.token },
      get ip(): string {
        throw new Error('boom');
      },
    };
    await expectRejection(
      authenticator.authenticateOptional('staff', broken as unknown as FastifyRequest, stages),
      /boom/,
    );
  });
});

describe('the guard dispatcher', () => {
  it('has a handler for every access kind', () => {
    const handlers = t.app.get(AccessHandlers);
    for (const kind of ACCESS_KINDS) expect(handlers.handlerFor(kind), kind).toBeDefined();
  });

  it('refuses a route that has no contract', async () => {
    const res = await get('/t/sec/no-contract');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.json().detail).toContain('no route contract');
  });

  it('gives every machine kind its guard: a request without credentials is refused, never let through', async () => {
    const handlers = t.app.get(AccessHandlers);
    // What each guard answers to a request that brings nothing it can use (the machine-auth tests cover the accepted cases).
    const expected: Record<string, [number, string]> = {
      'api-key': [401, 'UNAUTHORIZED'],
      'url-secret': [401, 'UNAUTHORIZED'],
      'gateway-signature': [400, 'WEBHOOK_SIGNATURE_INVALID'],
      'checkout-token': [404, 'NOT_FOUND'],
      'tracking-token': [404, 'NOT_FOUND'],
      'ticket-token': [404, 'NOT_FOUND'],
      'link-token': [410, 'TOKEN_INVALID'],
    };
    for (const [kind, url] of Object.entries(PLACEHOLDER_URLS)) {
      expect(handlers.isPlaceholder(kind as never), kind).toBe(false);
      const res = await get(url, { authorization: 'Bearer anything', 'x-api-key': 'anything' });
      const [status, code] = expected[kind]!;
      expect(res.statusCode, kind).toBe(status);
      expect(res.json().code, kind).toBe(code);
      expect(res.headers['content-type'], kind).toContain('application/problem+json');
    }
  });

  it('answers the Dhru surface with the Dhru envelope: HTTP 200 and Authentication Failed', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      payload: { action: 'accountinfo', username: 'u', apiaccesskey: 'k' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' });
  });

  it('lets a feature or a test replace the handler of a kind', async () => {
    const own = await createTestApp({ controllers: [SecurityTestController] });
    try {
      const handlers = own.app.get(AccessHandlers);
      expect((await own.app.inject({ method: 'GET', url: PLACEHOLDER_URLS['api-key']! })).statusCode).toBe(401);
      handlers.replace('api-key', { authenticate: () => ({}) });
      expect((await own.app.inject({ method: 'GET', url: PLACEHOLDER_URLS['api-key']! })).statusCode).toBe(200);
      expect((await own.app.inject({ method: 'GET', url: PLACEHOLDER_URLS['link-token']! })).statusCode).toBe(410);
    } finally {
      await own.close();
    }
  });

  it('leaves public routes, health and the docs open', async () => {
    for (const url of ['/health', '/admin/t/sec/public', '/openapi.json', '/docs']) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
  });

  it('applies the network-or-token rule of /metrics through the contract (internal-or-token)', async () => {
    expect((await get('/metrics')).statusCode).toBe(200);
    const withToken = await createTestApp({ env: { METRICS_TOKEN: 'm'.repeat(20) } });
    try {
      expect((await withToken.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(403);
      const ok = await withToken.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${'m'.repeat(20)}` },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await withToken.close();
    }
  });

  it('treats HEAD like GET', async () => {
    expect((await t.app.inject({ method: 'HEAD', url: '/admin/t/sec/session' })).statusCode).toBe(401);
    const { session } = await signInStaff(t, []);
    expect(
      (await t.app.inject({ method: 'HEAD', url: '/admin/t/sec/session', headers: session.headers })).statusCode,
    ).toBe(200);
  });
});
