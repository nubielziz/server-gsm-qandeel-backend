// Integration tests of the cached session and API key views (decision 055) on the real application, Postgres and the cache Redis: a view
// written into the cache without the server's seal, or sealed for another credential, never authenticates anyone; an invalidation that
// follows a revoke or a role change and fails once is retried, so the change applies on the next request.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type CacheKey, CACHE_MAC_LABEL, CacheKeys, cacheMacKey, openEntry, sealEntry } from '@src/infra/cache';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { ApiKeyDirectory, RolePermissions, SessionService } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff, openSession } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { MachineTestController, insertApiKey } from '../../support/machine-auth';
import { SecurityTestController } from '../../support/security-routes';

const clock = new TestClock('2026-11-22T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ controllers: [SecurityTestController, MachineTestController], clock });
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-22T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

const redis = () => t.app.get(RedisService).cache;
const keys = () => t.app.get(CacheKeys);
const hashOf = (token: string) => t.app.get(TokenService).hash(token);
const macKey = () => cacheMacKey(t.config.security.tokenPepper);
const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

/** Reads and opens what the cache holds under a key; fails the test when it is not a sealed entry. */
async function storedView<T>(key: CacheKey): Promise<T> {
  const opened = openEntry(macKey(), key, (await redis().get(key)) ?? '');
  if (typeof opened === 'string') throw new Error(`the cached entry is ${opened}`);
  return opened.value as T;
}

/** Runs `work` while the cache Redis's `unlink` fails exactly once. */
async function withOneFailedUnlink<T>(work: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const client = redis();
  const original = client.unlink.bind(client);
  let calls = 0;
  (client as unknown as { unlink: unknown }).unlink = (...args: Parameters<typeof original>) => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('connection reset by the cache Redis')) : original(...args);
  };
  try {
    return { result: await work(), calls };
  } finally {
    (client as unknown as { unlink: unknown }).unlink = original;
  }
}

/** Staff A with `staff:read` and a session, and an Owner B. */
async function staffPair() {
  const { db } = await testDb();
  const readerRole = await insertRole(db, ['staff:read']);
  const ownerRole = await insertRole(db, ['*']);
  const staffA = await insertStaff(db, readerRole);
  const staffB = await insertStaff(db, ownerRole);
  const session = await openSession(t, { type: 'staff', id: staffA });
  return { readerRole, ownerRole, staffA, staffB, session };
}

describe('cached session views (decision 055)', () => {
  it('a session view written into the cache without the server seal does not authenticate anyone else', async () => {
    const { readerRole, ownerRole, staffA, staffB, session } = await staffPair();
    const key = keys().session(hashOf(session.token));
    // Load A's own view once, then plant the previous release's envelope of a view that says staff B, the Owner role.
    expect((await get('/admin/t/sec/who', session.headers)).statusCode).toBe(200);
    const view = await storedView<Record<string, unknown> & { subject: Record<string, unknown> }>(key);
    const planted = { ...view, subjectId: staffB, subject: { ...view.subject, roleId: ownerRole } };
    const far = clock.nowMs() + 3_600_000;
    await redis().set(key, JSON.stringify({ v: planted, f: far }), 'PX', 60_000);

    const res = await get('/admin/t/sec/who', session.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ staffId: staffA, roleId: readerRole, permissions: ['staff:read'] });
  });

  it('a sealed session view of another token is refused', async () => {
    const { session } = await staffPair();
    const other = await openSession(t, { type: 'staff', id: (await staffPair()).staffB });
    const key = keys().session(hashOf(session.token));
    const otherKey = keys().session(hashOf(other.token));
    expect((await get('/admin/t/sec/who', other.headers)).statusCode).toBe(200);
    const otherView = await storedView<Record<string, unknown>>(otherKey);
    // A view that is sealed by the server, but whose token hash is the other token's, under A's key.
    await redis().set(key, sealEntry(macKey(), key, otherView, clock.nowMs() + 3_600_000), 'PX', 60_000);

    expect((await get('/admin/t/sec/who', session.headers)).statusCode).toBe(401);
    expect(await redis().exists(key)).toBe(0);
  });

  it('a revoke whose first cache delete fails still ends the session at once', async () => {
    const { session } = await staffPair();
    const key = keys().session(hashOf(session.token));
    expect((await get('/admin/t/sec/who', session.headers)).statusCode).toBe(200);
    expect(await redis().exists(key)).toBe(1);

    const { result, calls } = await withOneFailedUnlink(() => t.app.get(SessionService).revoke(session.sessionId));
    expect(result).toBe(true);
    expect(calls).toBe(2);
    expect((await get('/admin/t/sec/who', session.headers)).statusCode).toBe(401);
  });

  it('a role change whose first cache delete fails applies on the next request', async () => {
    const { readerRole, session } = await staffPair();
    expect((await get('/admin/t/sec/needs-read', session.headers)).statusCode).toBe(200);
    expect(await redis().exists(keys().rolePermissions(readerRole))).toBe(1);

    const roles = t.app.get(RolePermissions);
    const { calls } = await withOneFailedUnlink(() =>
      t.app.get(DbService).runInTransaction(async ({ tx, afterCommit }) => {
        await tx
          .update(s.roles)
          .set({ permissions: ['orders:read'] })
          .where(eq(s.roles.id, readerRole));
        await roles.invalidate(readerRole, { afterCommit });
      }),
    );
    expect(calls).toBe(2);
    expect((await get('/admin/t/sec/needs-read', session.headers)).statusCode).toBe(403);
  });
});

describe('cached API key views (decision 055)', () => {
  it('an API key view of another key is refused', async () => {
    const { db } = await testDb();
    const clientId = await insertMerchant(db);
    const first = await insertApiKey(t, db, clientId);
    const second = await insertApiKey(t, db, clientId, {
      scopes: ['orders:read', 'orders:write', 'dhru', 'account:read'],
    });
    const call = (key: string) =>
      t.app.inject({ method: 'GET', url: '/v1/t/mach/read', headers: { authorization: `Bearer ${key}` } });
    expect((await call(second.key)).statusCode).toBe(200);
    // The call's touch dropped the view (last use); a lookup stores it again.
    await t.app.get(ApiKeyDirectory).findByKey(second.key);
    const secondView = await storedView<Record<string, unknown>>(keys().apiKey(second.keyHash));
    const firstKey = keys().apiKey(first.keyHash);
    await redis().set(firstKey, sealEntry(macKey(), firstKey, secondView, clock.nowMs() + 3_600_000), 'PX', 60_000);

    expect((await call(first.key)).statusCode).toBe(401);
    expect(await redis().exists(firstKey)).toBe(0);
    // The next call loads the key's own view again.
    expect((await call(first.key)).statusCode).toBe(200);
  });

  it('an API-key lookup of the label text stores a key name that is not the hex of the seal key', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/t/mach/read',
      headers: { authorization: `Bearer ${CACHE_MAC_LABEL}` },
    });
    expect(res.statusCode).toBe(401);
    const negative = keys().apiKey(hashOf(CACHE_MAC_LABEL));
    expect(await redis().exists(negative)).toBe(1);
    const sealHex = macKey().toString('hex');
    expect(negative).not.toContain(sealHex);
    expect(await redis().keys(`*${sealHex}*`)).toEqual([]);
  });
});
