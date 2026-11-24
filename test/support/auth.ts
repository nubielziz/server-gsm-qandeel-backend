// Test helpers for the security tests: accounts (roles, staff, merchants), signed-in sessions with their cookie and CSRF
// header, and a cache cleaner. Sessions are created with the real SessionService, so the guards see exactly what sign-in makes.
import { randomUUID } from 'node:crypto';
import { parseEnv } from '@src/config';
import { CacheKeys, CacheService } from '@src/infra/cache';
import { RedisService } from '@src/infra/redis';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { CsrfService, IpRuleCache, SessionCookies, SessionService } from '@src/modules/identity';
import type { SessionStage, SubjectType } from '@src/modules/identity/db/schema';
import { RankKinds } from '@src/modules/identity/security/rank-kinds';
import { ensureMerchantGroup } from './accounts';
import { PRODUCTION_ENV, type TestApp } from './app';
import { TEST_DATABASE_URL, testDb } from './db';
import { testInstanceEnv } from './env';

/** Inserts a role with the given permissions; returns its id. */
export async function insertRole(
  db: Database,
  permissions: string[],
  name = `Role ${randomUUID().slice(0, 8)}`,
): Promise<number> {
  const [role] = await db.insert(s.roles).values({ name, permissions }).returning({ id: s.roles.id });
  return role!.id;
}

/** Inserts an active staff member with a unique email; returns the id. */
export async function insertStaff(
  db: Database,
  roleId: number,
  overrides: Partial<typeof s.staffUsers.$inferInsert> = {},
): Promise<number> {
  const [staff] = await db
    .insert(s.staffUsers)
    .values({ email: `staff-${randomUUID()}@example.com`, name: 'Test Staff', roleId, status: 'active', ...overrides })
    .returning({ id: s.staffUsers.id });
  return staff!.id;
}

/**
 * Inserts an active account of the merchant rank (and the merchant rank it needs); returns the id.
 *
 * Why: the rank is the only thing that tells a merchant from a retail account, so the account takes a rank of the merchant kind
 * (`b2b`), never the first rank of any kind (which can be the retail one).
 *
 * @param db the test database
 * @param overrides columns to change
 * @returns the account id
 */
export async function insertMerchant(
  db: Database,
  overrides: Partial<typeof s.clients.$inferInsert> = {},
): Promise<number> {
  const groupId = await ensureMerchantGroup(db);
  const unique = randomUUID();
  const [client] = await db
    .insert(s.clients)
    .values({
      username: `merchant-${unique}`,
      email: `merchant-${unique}@example.com`,
      name: 'Test Merchant',
      groupId,
      referralCode: `REF-${unique}`,
      status: 'active',
      ...overrides,
    })
    .returning({ id: s.clients.id });
  return client!.id;
}

/** A signed-in session as a test client sends it. */
export interface TestSession {
  readonly sessionId: number;
  readonly token: string;
  /** The `cookie` header carrying the session token. */
  readonly cookie: string;
  /** The CSRF token the sign-in would have answered with. */
  readonly csrf: string;
  /** Headers for a GET: the cookie. */
  readonly headers: Record<string, string>;
  /** Headers for a mutation: the cookie and the CSRF token. */
  readonly mutationHeaders: Record<string, string>;
}

/**
 * Opens a session for an account the way sign-in does.
 *
 * @param t the running test app
 * @param subject the person: `staff`, or `account` for an account of any rank (the rank is the account's, not the session's)
 * @param options the stage (default `active`) and an optional lifetime in seconds
 * @returns the token, the cookie header and the CSRF token
 */
export async function openSession(
  t: TestApp,
  subject: { readonly type: SubjectType; readonly id: number },
  options: { readonly stage?: SessionStage; readonly ttlSeconds?: number } = {},
): Promise<TestSession> {
  const issued = await t.app.get(SessionService).create({
    subjectType: subject.type,
    subjectId: subject.id,
    stage: options.stage ?? 'active',
    ip: '203.0.113.7',
    userAgent: 'bun-test',
    ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
  });
  return sessionOf(t, subject.type, issued.token, issued.session.id);
}

/** Wraps a token the app issued (for example after a rotation) in the headers a client would send. */
export function sessionOf(t: TestApp, subjectType: SubjectType, token: string, sessionId = 0): TestSession {
  const cookie = `${t.app.get(SessionCookies).sessionCookieName(subjectType)}=${token}`;
  const csrf = t.app.get(CsrfService).tokenFor(t.app.get(TokenService).hash(token));
  return {
    sessionId,
    token,
    cookie,
    csrf,
    headers: { cookie },
    mutationHeaders: { cookie, 'x-csrf-token': csrf },
  };
}

/** Signs a staff member in with a fresh role: returns the session and the ids. */
export async function signInStaff(
  t: TestApp,
  permissions: string[],
  options: { readonly stage?: SessionStage } = {},
): Promise<{ session: TestSession; staffId: number; roleId: number }> {
  const { db } = await testDb();
  const roleId = await insertRole(db, permissions);
  const staffId = await insertStaff(db, roleId);
  return { session: await openSession(t, { type: 'staff', id: staffId }, options), staffId, roleId };
}

/**
 * Deletes the cached sessions, role permissions, settings and IP rules of the test app, and the retail rank id the app remembers (the
 * database is reset between tests, and a reset restarts the ids).
 *
 * Why the IP rules: their snapshot is served from the cache for minutes, which outlives a test file. After a file that seeds an
 * allowlist for the console, the staff requests of the next file would be refused from every other address.
 *
 * Why the retail rank: `RankKinds` keeps the id of the one retail rank in memory, because the product never deletes that rank. `resetDb`
 * does, and restarts the ids, so the id the retail rank had in one test can be a merchant rank in the next, whose accounts would then
 * meet the rank gate of a retail account.
 */
export async function clearIdentityCaches(t: TestApp): Promise<void> {
  const cache = t.app.get(CacheService);
  const keys = t.app.get(CacheKeys);
  await cache.delByPrefix(keys.prefix('identity', 'session'));
  await cache.delByPrefix(keys.prefix('identity', 'role'));
  await cache.del(keys.settings());
  await t.app.get(IpRuleCache).invalidate();
  // a database reset restarts the ids: the retail rank id the app remembered may now belong to a merchant rank
  t.app.get(RankKinds).forgetRetail();
}

/**
 * Deletes the counters of the limiters a sign-in touches (per address, per email and network, per link, the code and mail budgets) and the
 * failed-sign-in counters and locks.
 *
 * Why: the counters live 15 minutes in the cache Redis, which outlives a test run; a test that signs the same account in from the
 * same address on every run would meet the lock of the run before.
 *
 * @param t the running test app
 */
export async function clearRateLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const keys = t.app.get(CacheKeys);
  for (const limiter of ['ip', 'sign-in', 'sign-in-code', 'sign-in-familiar', 'account-mail', 'token'] as const) {
    const found = await redis.keys(`${keys.rateLimit(limiter)}:*`);
    if (found.length > 0) await redis.del(...found);
  }
  const failures = await redis.keys(`${keys.keyspace}identity:sign-in-failures:*`);
  if (failures.length > 0) await redis.del(...failures);
}

/**
 * A production configuration whose database and Redis are the test instances.
 *
 * Why: `PRODUCTION_ENV` names hosts that do not exist, which is right for configuration tests but leaves nothing to sign in
 * against. With the test instances behind it, a test can run the real guards with production rules (Secure cookies with the
 * `__Host-` prefix, the audit enforcement that only logs, the staff-only reference pages).
 *
 * @param extra more variables, for example `CONSOLE_ORIGINS`
 * @returns variables for `createTestApp({ env })`
 */
export function productionEnvOnTestInstances(extra: Record<string, string> = {}): Record<string, string> {
  const instances = parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() });
  return {
    ...PRODUCTION_ENV,
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_QUEUE_URL: instances.redis.queueUrl,
    REDIS_CACHE_URL: instances.redis.cacheUrl,
    ...extra,
  };
}
