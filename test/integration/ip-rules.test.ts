// Integration tests of the IP rules stage (scenario ip-rules, P2.5b) on the real application, Postgres and the cache Redis of
// the test instances: block rules by scope, the admin allowlist, expiry, address forms (IPv6, IPv4-mapped, TRUST_PROXY, escaped
// paths), the cache and its invalidation, Redis or Postgres being down, the hit counters and their flush job in a real worker.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { parseEnv } from '../../src/config';
import { CacheKeys, CacheModule, decodeEntry } from '../../src/infra/cache';
import { DbModule, DbService, schema as s } from '../../src/infra/db';
import { MetricsModule, MetricsService } from '../../src/infra/metrics';
import {
  JobSchedulerRegistry,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
} from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  IP_RULE_HITS_FLUSH_JOB,
  IP_RULE_HITS_FLUSH_SCHEDULER,
  IpRuleCache,
  IpRuleHits,
  IpRuleHitsFlush,
  IpRuleHitsFlushModule,
} from '../../src/modules/identity';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { type TestApp, createTestApp } from '../support/app';
import { HOUR, SECOND, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { createInfra, deadRedisUrl, eventually } from '../support/infra';
import { metricValue } from '../support/metrics';
import {
  PipelineTestController,
  TestAccessModule,
  freshClientIp as freshIp,
  freshClientPrefix,
} from '../support/pipeline-routes';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';
import { TestController } from '../support/routes';

const AUTH = { 'x-test-auth': '1' };
/** The clock of every app in this file: rule expiry, the in-memory copy and the hit times follow it (decision 031). */
const clock = new TestClock();

let t: TestApp;
const extraApps: TestApp[] = [];

const appOptions = {
  controllers: [TestController, PipelineTestController],
  imports: [TestAccessModule],
  clock,
};
// The API process does not load the flush; the hit-counter tests add it to reach IpRuleHitsFlush (and run it by hand).
const withFlush = { ...appOptions, imports: [...appOptions.imports, IpRuleHitsFlushModule] };

beforeAll(async () => {
  await resetDb();
  t = await createTestApp(withFlush);
});

/** Empties the rules, the settings and the caches and counters that hold them (other test files share the instances). */
async function clean(): Promise<void> {
  const { db } = await testDb();
  await db.delete(s.ipRules);
  await db.delete(s.settings);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(RedisService).cache.del(t.app.get(CacheKeys).ipRuleHits());
}
afterAll(async () => {
  await clean();
  await t.close();
  await Promise.all(extraApps.map((other) => other.close()));
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await clean();
});

type RuleValues = { kind: 'allow' | 'block'; scope: 'store' | 'api' | 'admin' | 'all'; cidr: string } & Partial<
  typeof s.ipRules.$inferInsert
>;

/** Inserts a rule and refreshes the cache the way the IP rule routes will after their commit. */
async function addRule(values: RuleValues, app: TestApp = t): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.ipRules)
    .values({ reason: 'test', ...values })
    .returning({ id: s.ipRules.id });
  await app.app.get(IpRuleCache).invalidate();
  return row!.id;
}

async function restrictAdmin(on: boolean, app: TestApp = t): Promise<void> {
  const { db } = await testDb();
  await db.delete(s.settings);
  await db.insert(s.settings).values({ key: 'adminAllowlistOnly', value: on });
  await app.app.get(IpRuleCache).invalidate();
}

const call = (app: TestApp, method: 'GET' | 'POST', url: string, ip: string, headers: Record<string, string> = {}) =>
  app.app.inject({ method, url, remoteAddress: ip, headers, ...(method === 'POST' ? { payload: {} } : {}) });
const get = (url: string, ip: string, headers: Record<string, string> = {}) => call(t, 'GET', url, ip, headers);

// The Dhru surface answers every refusal in its own envelope with HTTP 200 (decision 026).
const isIpRefusal = (res: LightMyRequestResponse) => {
  if (!String(res.headers['content-type'] ?? '').includes('json')) return false;
  const body = res.json<{ code?: string; ERROR?: Array<{ MESSAGE?: string }> }>();
  if (body.ERROR) return res.statusCode === 200 && /blocked|not allowed/i.test(body.ERROR[0]?.MESSAGE ?? '');
  return res.statusCode === 403 && body.code === 'IP_NOT_ALLOWED';
};

describe('block rules by scope', () => {
  const REQUESTS: Record<string, { audience: string; send: (ip: string) => Promise<LightMyRequestResponse> }> = {
    'admin console': { audience: 'admin', send: (ip) => get('/admin/t/session', ip, AUTH) },
    'storefront route': { audience: 'store', send: (ip) => get('/store/v1/t/ping', ip, AUTH) },
    'unknown storefront path': { audience: 'store', send: (ip) => get('/store/v1/nope', ip) },
    'REST v1': { audience: 'api', send: (ip) => get('/v1/t/ping', ip, AUTH) },
    Dhru: { audience: 'api', send: (ip) => call(t, 'POST', '/api/index.php', ip) },
    'merchant portal': { audience: 'other', send: (ip) => get('/client/t/ping', ip, AUTH) },
    // Never judged: signed gateway webhooks must not be lost to a broad block (B118).
    'incoming webhook': { audience: 'none', send: (ip) => call(t, 'POST', '/webhooks/t/ping', ip, AUTH) },
    'documentation page': { audience: 'other', send: (ip) => get('/docs', ip) },
  };

  for (const scope of ['store', 'api', 'admin', 'all'] as const) {
    it(`a block with scope "${scope}" refuses ${scope === 'all' ? 'every audience' : `the ${scope} audience only`}`, async () => {
      const blocked = freshIp();
      await addRule({ kind: 'block', scope, cidr: blocked });
      for (const [name, request] of Object.entries(REQUESTS)) {
        const res = await request.send(blocked);
        const expected = request.audience !== 'none' && (scope === 'all' || request.audience === scope);
        expect(isIpRefusal(res), `${name}: status ${res.statusCode}`).toBe(expected);
        // Another address is untouched.
        expect(isIpRefusal(await request.send(freshIp())), `${name} from another address`).toBe(false);
      }
    });
  }

  it('never judges /health and /metrics, even for an address blocked everywhere', async () => {
    await addRule({ kind: 'block', scope: 'all', cidr: '127.0.0.1' });
    expect((await get('/health', '127.0.0.1')).statusCode).toBe(200);
    expect((await get('/metrics', '127.0.0.1')).statusCode).toBe(200);
    expect(isIpRefusal(await get('/store/v1/t/ping', '127.0.0.1', AUTH))).toBe(true);
  });

  it('answers a refusal with the session-ending code, problem+json and no information about accounts', async () => {
    const blocked = freshIp();
    await addRule({ kind: 'block', scope: 'admin', cidr: blocked, reason: 'Repeated failed admin sign-ins' });
    const res = await get('/admin/t/session', blocked);
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      status: 403,
      code: 'IP_NOT_ALLOWED',
      detail: `Your network address (${blocked}) is blocked.`,
    });
    // The reason staff wrote is internal.
    expect(res.body).not.toContain('Repeated failed');
  });
});

describe('the admin allowlist (setting adminAllowlistOnly)', () => {
  it('lets only listed addresses use the admin console while the restriction is on, and nothing else changes', async () => {
    const office = freshIp();
    const stranger = freshIp();
    await addRule({ kind: 'allow', scope: 'admin', cidr: office, label: 'Office' });
    await restrictAdmin(true);
    expect((await get('/admin/t/session', office, AUTH)).statusCode).toBe(200);
    const refused = await get('/admin/t/session', stranger, AUTH);
    expect(isIpRefusal(refused)).toBe(true);
    expect(refused.json().detail).toContain('is not on the list of addresses allowed to use the admin console');
    // The other audiences do not ask for an allow rule.
    for (const url of ['/store/v1/t/ping', '/v1/t/ping', '/client/t/ping']) {
      expect((await get(url, stranger, AUTH)).statusCode, url).toBe(200);
    }
    expect((await get('/health', stranger)).statusCode).toBe(200);
  });

  it('opens the console to everyone again when the restriction is switched off', async () => {
    const stranger = freshIp();
    await restrictAdmin(true);
    expect(isIpRefusal(await get('/admin/t/session', stranger, AUTH))).toBe(true);
    await restrictAdmin(false);
    expect((await get('/admin/t/session', stranger, AUTH)).statusCode).toBe(200);
  });

  it('lets a block rule beat an allow rule on the same address', async () => {
    const office = freshIp();
    await addRule({ kind: 'allow', scope: 'admin', cidr: office });
    await addRule({ kind: 'block', scope: 'admin', cidr: office });
    await restrictAdmin(true);
    const res = await get('/admin/t/session', office, AUTH);
    expect(isIpRefusal(res)).toBe(true);
    expect(res.json().detail).toBe(`Your network address (${office}) is blocked.`);
  });

  it('allows a whole range, and ignores an allow rule that has expired', async () => {
    const range = freshIp().split('.').slice(0, 3).join('.');
    await addRule({ kind: 'allow', scope: 'admin', cidr: `${range}.0/24` });
    await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.200', expiresAt: new Date(clock.nowMs() - HOUR) });
    await restrictAdmin(true);
    expect((await get('/admin/t/session', `${range}.77`, AUTH)).statusCode).toBe(200);
    expect(isIpRefusal(await get('/admin/t/session', '203.0.113.200', AUTH))).toBe(true);
  });

  it('turns everyone away when the restriction is on and no allow rule is left', async () => {
    await restrictAdmin(true);
    expect(isIpRefusal(await get('/admin/t/session', freshIp(), AUTH))).toBe(true);
  });
});

describe('expiry', () => {
  it('drops a rule by itself when its expiry passes, without a reload', async () => {
    const blocked = freshIp();
    await addRule({ kind: 'block', scope: 'all', cidr: blocked, expiresAt: new Date(clock.nowMs() + 4 * SECOND) });
    expect(isIpRefusal(await get('/store/v1/t/ping', blocked, AUTH))).toBe(true);
    clock.advance(4 * SECOND - 1);
    expect(isIpRefusal(await get('/store/v1/t/ping', blocked, AUTH)), 'a millisecond before the expiry').toBe(true);
    clock.advance(1);
    expect((await get('/store/v1/t/ping', blocked, AUTH)).statusCode, 'at the expiry').toBe(200);
  });

  it('does not load a rule that expired before the load', async () => {
    const blocked = freshIp();
    await addRule({ kind: 'block', scope: 'all', cidr: blocked, expiresAt: new Date(clock.nowMs() - SECOND) });
    expect((await get('/store/v1/t/ping', blocked, AUTH)).statusCode).toBe(200);
  });
});

describe('address forms', () => {
  it('matches IPv6 ranges, and an IPv4-mapped client against the IPv4 rule', async () => {
    const prefix = freshClientPrefix();
    await addRule({ kind: 'block', scope: 'all', cidr: `${prefix}::/64` });
    expect(isIpRefusal(await get('/store/v1/t/ping', `${prefix}:1:2:3:4`, AUTH))).toBe(true);
    expect((await get('/store/v1/t/ping', `${freshClientPrefix()}:1:2:3:4`, AUTH)).statusCode).toBe(200);

    const v4 = freshIp();
    await addRule({ kind: 'block', scope: 'all', cidr: v4 });
    expect(isIpRefusal(await get('/store/v1/t/ping', `::ffff:${v4}`, AUTH))).toBe(true);
  });

  it('judges a matched route by its template, so an escaped spelling of /admin does not dodge a rule', async () => {
    const blocked = freshIp();
    const clear = freshIp();
    // The router decodes %61 before it matches, so both spellings reach the same route.
    expect((await get('/%61dmin/t/session', clear, AUTH)).statusCode).toBe(200);
    await addRule({ kind: 'block', scope: 'admin', cidr: blocked });
    expect(isIpRefusal(await get('/admin/t/session', blocked, AUTH))).toBe(true);
    expect(isIpRefusal(await get('/%61dmin/t/session', blocked, AUTH))).toBe(true);
    expect(isIpRefusal(await get('/%61dmin/nope', blocked))).toBe(true);
    // The same trick against the restriction.
    await restrictAdmin(true);
    expect(isIpRefusal(await get('/%61dmin/t/session', clear, AUTH))).toBe(true);
  });

  it('judges the real client address behind a trusted proxy, and ignores X-Forwarded-For when none is trusted', async () => {
    const proxied = await createTestApp({ ...appOptions, env: { TRUST_PROXY: 'loopback' } });
    extraApps.push(proxied);
    const blocked = freshIp();
    await addRule({ kind: 'block', scope: 'store', cidr: blocked }, proxied);
    // The proxy (127.0.0.1) reports the client in X-Forwarded-For.
    expect(
      isIpRefusal(await call(proxied, 'GET', '/store/v1/t/ping', '127.0.0.1', { ...AUTH, 'x-forwarded-for': blocked })),
    ).toBe(true);
    expect((await call(proxied, 'GET', '/store/v1/t/ping', '127.0.0.1', AUTH)).statusCode).toBe(200);
    // Without TRUST_PROXY a client cannot choose its address with a header.
    await t.app.get(IpRuleCache).invalidate();
    expect((await get('/store/v1/t/ping', '127.0.0.1', { ...AUTH, 'x-forwarded-for': blocked })).statusCode).toBe(200);
    expect(isIpRefusal(await get('/store/v1/t/ping', blocked, AUTH))).toBe(true);
  });
});

describe('the cache', () => {
  it('keeps the active rules and the restriction in the cache Redis, and invalidate() removes them', async () => {
    const redis = t.app.get(RedisService).cache;
    const key = t.app.get(CacheKeys).ipRules();
    const blocked = freshIp();
    const id = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: blocked,
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    await restrictAdmin(true);
    await get('/store/v1/t/ping', blocked, AUTH);
    const entry = decodeEntry((await redis.get(key)) ?? '');
    const snapshot = entry?.value as { restricted: boolean; rules: Array<Record<string, unknown>> };
    expect(snapshot.restricted).toBe(true);
    expect(snapshot.rules).toEqual([
      { id, kind: 'block', scope: 'store', cidr: `${blocked}/32`, expiresAt: expect.any(String) },
    ]);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(360_000 + 9_000);
    await t.app.get(IpRuleCache).invalidate();
    expect(await redis.get(key)).toBeNull();
  });

  it('does not see a rule written straight to the table until invalidate() is called, then sees it at once', async () => {
    const blocked = freshIp();
    expect((await get('/store/v1/t/ping', blocked, AUTH)).statusCode).toBe(200);
    const { db } = await testDb();
    await db.insert(s.ipRules).values({ kind: 'block', scope: 'store', cidr: blocked, reason: 'test' });
    expect((await get('/store/v1/t/ping', blocked, AUTH)).statusCode).toBe(200);
    await t.app.get(IpRuleCache).invalidate();
    expect(isIpRefusal(await get('/store/v1/t/ping', blocked, AUTH))).toBe(true);
  });

  it('is refreshed by afterCommit(() => invalidate()) of the transaction that changes a rule, and not by a rolled-back one', async () => {
    const db = t.app.get(DbService);
    const rolledBack = freshIp();
    const committed = freshIp();
    // Load the snapshot first, so a stale one would show.
    expect((await get('/store/v1/t/ping', committed, AUTH)).statusCode).toBe(200);
    await expectRejection(
      db.runInTransaction(async ({ tx, afterCommit }) => {
        await tx.insert(s.ipRules).values({ kind: 'block', scope: 'store', cidr: rolledBack, reason: 'test' });
        afterCommit(() => t.app.get(IpRuleCache).invalidate());
        throw new Error('the use case failed');
      }),
      'the use case failed',
    );
    expect((await get('/store/v1/t/ping', rolledBack, AUTH)).statusCode).toBe(200);
    await db.runInTransaction(async ({ tx, afterCommit }) => {
      await tx.insert(s.ipRules).values({ kind: 'block', scope: 'store', cidr: committed, reason: 'test' });
      afterCommit(() => t.app.get(IpRuleCache).invalidate());
    });
    expect(isIpRefusal(await get('/store/v1/t/ping', committed, AUTH))).toBe(true);
  });

  it('shows a change to another API instance within a second', async () => {
    const other = await createTestApp(appOptions);
    extraApps.push(other);
    const blocked = freshIp();
    expect((await call(other, 'GET', '/store/v1/t/ping', blocked, AUTH)).statusCode).toBe(200);
    await addRule({ kind: 'block', scope: 'store', cidr: blocked });
    // The other instance keeps its in-memory copy for a second, then reads the cache and the database again.
    clock.advance(SECOND - 1);
    expect((await call(other, 'GET', '/store/v1/t/ping', blocked, AUTH)).statusCode).toBe(200);
    clock.advance(1);
    expect(isIpRefusal(await call(other, 'GET', '/store/v1/t/ping', blocked, AUTH))).toBe(true);
  });
});

describe('when Redis or Postgres is down', () => {
  it('reads the rules from Postgres when the cache Redis is down, still counts nothing it cannot, and never fails', async () => {
    const down = await createTestApp({ ...appOptions, env: { REDIS_CACHE_URL_TEST: await deadRedisUrl(3) } });
    extraApps.push(down);
    const blocked = freshIp();
    // With the cache Redis away nothing holds a copy, so a plain insert is seen by the next load.
    const { db } = await testDb();
    await db.insert(s.ipRules).values({ kind: 'block', scope: 'all', cidr: blocked, reason: 'test' });
    expect(isIpRefusal(await call(down, 'GET', '/store/v1/t/ping', blocked, AUTH))).toBe(true);
    expect((await call(down, 'GET', '/store/v1/t/ping', freshIp(), AUTH)).statusCode).toBe(200);
    await down.app.get(IpRuleHits).idle();
    const text = await down.app.get(MetricsService).render();
    expect(metricValue(text, 'ip_rule_hit_record_failures_total', { reason: 'redis' })).toBeGreaterThanOrEqual(1);
  });

  it('refuses with 503 DATABASE_UNAVAILABLE when no copy of the rules exists and Postgres is down, but still answers /health', async () => {
    await clean(); // no entry in Redis
    const url = new URL(parseEnv({ NODE_ENV: 'test' }).database.testUrl);
    url.port = '1'; // nothing listens there
    const down = await createTestApp({ ...appOptions, env: { DATABASE_URL_TEST: url.toString() } });
    extraApps.push(down);
    const res = await call(down, 'GET', '/store/v1/t/ping', freshIp(), AUTH);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect((await call(down, 'GET', '/health', freshIp())).json().code).toBeUndefined();
  });

  it('keeps using the last known rules when Postgres goes away after they were loaded', async () => {
    const stored = await get('/store/v1/t/ping', freshIp(), AUTH);
    expect(stored.statusCode).toBe(200);
    // The cache Redis still holds the snapshot: an app whose database is unreachable serves from it.
    const url = new URL(parseEnv({ NODE_ENV: 'test' }).database.testUrl);
    url.port = '1';
    const down = await createTestApp({ ...appOptions, env: { DATABASE_URL_TEST: url.toString() } });
    extraApps.push(down);
    expect((await call(down, 'GET', '/store/v1/t/ping', freshIp(), AUTH)).statusCode).toBe(200);
  });
});

describe('hit counters and their flush', () => {
  const hits = () => t.app.get(IpRuleHits);
  const flusher = () => t.app.get(IpRuleHitsFlush);
  const redisHash = () => t.app.get(RedisService).cache.hgetall(t.app.get(CacheKeys).ipRuleHits());
  const row = async (id: number) => {
    const { db } = await testDb();
    const [found] = await db
      .select()
      .from(s.ipRules)
      .where(sql`${s.ipRules.id} = ${id}`);
    return found!;
  };

  it('counts the requests a rule decided in Redis, and the flush writes them to hit_count and last_hit_at', async () => {
    const blocked = freshIp();
    const office = freshIp();
    const blockId = await addRule({ kind: 'block', scope: 'store', cidr: blocked });
    const allowId = await addRule({ kind: 'allow', scope: 'admin', cidr: office });
    await restrictAdmin(true);
    const before = clock.nowMs();
    for (let i = 0; i < 3; i++) await get('/store/v1/t/ping', blocked, AUTH);
    for (let i = 0; i < 2; i++) await get('/admin/t/session', office, AUTH);
    await get('/admin/t/session', freshIp(), AUTH); // not listed: no rule decided
    await get('/store/v1/t/ping', freshIp(), AUTH); // open: no rule decided
    await hits().idle();

    const pending = await redisHash();
    expect(pending[String(blockId)]).toBe('3');
    expect(pending[String(allowId)]).toBe('2');
    expect(Number(pending[`${blockId}:at`])).toBe(before);
    expect(Object.keys(pending)).toHaveLength(4);
    expect(await t.app.get(RedisService).cache.pttl(t.app.get(CacheKeys).ipRuleHits())).toBeGreaterThan(23 * HOUR);

    expect(await flusher().flush()).toEqual({ rules: 2, hits: 5 });
    expect(await redisHash()).toEqual({});
    const block = await row(blockId);
    expect(block.hitCount).toBe(3);
    expect(block.lastHitAt!.getTime()).toBe(before);
    expect((await row(allowId)).hitCount).toBe(2);

    // Nothing is counted twice, and counting goes on.
    expect(await flusher().flush()).toEqual({ rules: 0, hits: 0 });
    await get('/store/v1/t/ping', blocked, AUTH);
    await hits().idle();
    expect(await flusher().flush()).toEqual({ rules: 1, hits: 1 });
    expect((await row(blockId)).hitCount).toBe(4);

    const text = await t.app.get(MetricsService).render();
    expect(metricValue(text, 'ip_rule_hits_flushed_total', {})).toBeGreaterThanOrEqual(6);
    expect(metricValue(text, 'ip_rule_hits_flush_last_success_timestamp_seconds', {})).toBe(before / 1000);
  });

  it('counts a hit once however many flushes run at the same time', async () => {
    const id = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
    for (let i = 0; i < 10; i++) hits().record(id);
    await hits().idle();
    const results = await Promise.all([flusher().flush(), flusher().flush(), flusher().flush()]);
    expect(results.reduce((sum, result) => sum + result.hits, 0)).toBe(10);
    expect((await row(id)).hitCount).toBe(10);
  });

  it('drops the hits of a rule that was deleted meanwhile, and saturates instead of overflowing hit_count', async () => {
    const gone = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
    const busy = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
    const { db } = await testDb();
    await db
      .update(s.ipRules)
      .set({ hitCount: 2_147_483_640 })
      .where(sql`${s.ipRules.id} = ${busy}`);
    hits().record(gone);
    for (let i = 0; i < 100; i++) hits().record(busy);
    await hits().idle();
    await db.delete(s.ipRules).where(sql`${s.ipRules.id} = ${gone}`);
    expect(await flusher().flush()).toEqual({ rules: 2, hits: 101 });
    expect((await row(busy)).hitCount).toBe(2_147_483_647);
  });

  it('never moves last_hit_at backwards', async () => {
    const id = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
    const future = new Date(clock.nowMs() + 24 * HOUR);
    const { db } = await testDb();
    await db
      .update(s.ipRules)
      .set({ lastHitAt: future })
      .where(sql`${s.ipRules.id} = ${id}`);
    hits().record(id);
    await hits().idle();
    await flusher().flush();
    expect((await row(id)).lastHitAt!.getTime()).toBe(future.getTime());
  });

  it('puts the counts back in Redis when the database write fails, together with hits that arrived meanwhile', async () => {
    const id = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
    const redis = t.app.get(RedisService);
    const keys = t.app.get(CacheKeys);
    const real = t.app.get(IpRuleHits);
    const realFlush = t.app.get(IpRuleHitsFlush);
    const failingDb = {
      db: {
        execute: async () => {
          // A request is refused while the write is going on.
          real.record(id);
          await real.idle();
          throw new Error('database went away');
        },
      },
    } as unknown as DbService;
    const failing = new IpRuleHitsFlush(redis, keys, failingDb, new MetricsService(), clock);
    for (let i = 0; i < 2; i++) real.record(id);
    await real.idle();
    await expectRejection(failing.flush(), 'database went away');
    expect((await redisHash())[String(id)]).toBe('3');
    // The next flush, with a working database, loses nothing.
    expect(await realFlush.flush()).toEqual({ rules: 1, hits: 3 });
    expect((await row(id)).hitCount).toBe(3);
  });

  it('writes nothing to job_runs: the flush is high-frequency housekeeping (decision 020)', async () => {
    const { db } = await testDb();
    expect(await db.select().from(s.jobRuns)).toHaveLength(0);
  });
});

describe.skipIf(!existsSync(demoStatePath()))('the demo seed (roles, staff, IP rules, restriction on)', () => {
  // Seeds the whole demo (about 10 s alone): a minute, so a busy database server does not fail it.
  it('decides as the console shows it: offices on the allowlist, blocks by audience', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    await t.app.get(IpRuleCache).invalidate();
    // Allow rules: 203.0.113.24, 203.0.113.31, 198.51.100.77; the restriction is on.
    for (const office of ['203.0.113.24', '203.0.113.31', '198.51.100.77']) {
      expect((await get('/admin/t/session', office, AUTH)).statusCode, office).toBe(200);
    }
    expect(isIpRefusal(await get('/admin/t/session', '203.0.113.99', AUTH))).toBe(true);
    // Blocks: 192.0.2.0/24 store (auto), 198.51.100.200 admin (auto), 203.0.113.160/28 api, 198.51.100.231 everywhere.
    expect(isIpRefusal(await get('/store/v1/t/ping', '192.0.2.5', AUTH))).toBe(true);
    expect((await get('/v1/t/ping', '192.0.2.5', AUTH)).statusCode).toBe(200);
    expect(isIpRefusal(await get('/v1/t/ping', '203.0.113.170', AUTH))).toBe(true);
    expect((await get('/store/v1/t/ping', '203.0.113.170', AUTH)).statusCode).toBe(200);
    expect(isIpRefusal(await get('/admin/t/session', '198.51.100.200', AUTH))).toBe(true);
    for (const url of ['/store/v1/t/ping', '/v1/t/ping', '/admin/t/session', '/client/t/ping']) {
      expect(isIpRefusal(await get(url, '198.51.100.231', AUTH)), url).toBe(true);
    }
  }, 60_000);
});

describe('the flush job in a worker', () => {
  const prefix = testBullPrefix();
  afterAll(async () => {
    const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
    await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
    await cleaner.close();
  });

  it('is scheduled every minute on the maintenance queue and runs on a real worker, safe to run twice', async () => {
    const harness = await createInfra({
      modules: [
        MetricsModule,
        RedisModule,
        CacheModule,
        DbModule,
        QueuesModule,
        QueueWorkersModule,
        IpRuleHitsFlushModule,
      ],
      env: { BULL_PREFIX: prefix },
    });
    try {
      await harness.get(QueueWorkers).whenReady();
      expect(harness.get(JobSchedulerRegistry).list()).toContainEqual(
        expect.objectContaining({
          id: IP_RULE_HITS_FLUSH_SCHEDULER,
          queue: 'maintenance',
          jobName: IP_RULE_HITS_FLUSH_JOB,
          every: 60_000,
        }),
      );
      const queues = harness.get(QueuesService);
      const schedulers = await queues.queue('maintenance').getJobSchedulers();
      const scheduler = schedulers.find((candidate) => candidate.key === IP_RULE_HITS_FLUSH_SCHEDULER);
      // Every minute, and no BullMQ retry: the next tick is the retry.
      expect(scheduler).toMatchObject({ name: IP_RULE_HITS_FLUSH_JOB, every: 60_000 });
      expect(scheduler?.template?.opts?.attempts).toBe(1);

      const id = await addRule({ kind: 'block', scope: 'all', cidr: freshIp() });
      const recorder = t.app.get(IpRuleHits);
      for (let i = 0; i < 4; i++) recorder.record(id);
      await recorder.idle();
      await queues.add('maintenance', IP_RULE_HITS_FLUSH_JOB, {}, { jobId: 'flush-test-1' });
      await queues.add('maintenance', IP_RULE_HITS_FLUSH_JOB, {}, { jobId: 'flush-test-2' });
      const { db } = await testDb();
      const counted = await eventually(async () => {
        const [found] = await db
          .select()
          .from(s.ipRules)
          .where(sql`${s.ipRules.id} = ${id}`);
        return found?.hitCount === 4 ? found.hitCount : undefined;
      });
      expect(counted).toBe(4);
      // Both jobs have finished, and the second found nothing: still 4.
      await eventually(async () => {
        const counts = await queues.queue('maintenance').getJobCounts('completed', 'active', 'waiting');
        return counts.active === 0 && counts.waiting === 0 && (counts.completed ?? 0) >= 2 ? true : undefined;
      });
      const [after] = await db
        .select()
        .from(s.ipRules)
        .where(sql`${s.ipRules.id} = ${id}`);
      expect(after!.hitCount).toBe(4);
      expect(await db.select().from(s.jobRuns)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe('docs/queues.md', () => {
  const docs = readFileSync(join(import.meta.dir, '../../docs/queues.md'), 'utf8');
  const decision = readFileSync(join(import.meta.dir, '../../docs/decisions/020-outbox-and-queues.md'), 'utf8');

  it('lists the flush job and its scheduler, and the exception from job_runs (here and in decision 020)', () => {
    expect(docs).toContain(
      `\`${IP_RULE_HITS_FLUSH_SCHEDULER}\` | \`maintenance\` | \`${IP_RULE_HITS_FLUSH_JOB}\` | every minute`,
    );
    expect(docs).toContain(`\`${IP_RULE_HITS_FLUSH_JOB}\``);
    expect(docs).toMatch(/not recorded/);
    expect(decision).toContain(IP_RULE_HITS_FLUSH_JOB);
  });
});
