// Integration tests of RateLimitService (decision 021) on the test cache Redis: allow / deny / Retry-After, per-key limits,
// the sign-in lock-out and reset, the RATE_LIMITED helper (also through HTTP, with the Retry-After header), the Redis
// semaphore (acquire / release / expiry / limit), and the fallback to an in-memory limiter while Redis is down.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type QueryOf, Route, defineRoute } from '../../src/common/contract';
import { AppError } from '../../src/common/errors';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { MetricsService } from '../../src/infra/metrics';
import { RATE_LIMITERS, RateLimitService, rateLimitedError } from '../../src/infra/rate-limit';
import { RedisService } from '../../src/infra/redis';
import { type TestApp, createTestApp } from '../support/app';
import { type InfraHarness, createInfra, deadRedisUrl } from '../support/infra';
import { metricValue } from '../support/metrics';
import { expectRejection } from '../support/rejection';

let harness: InfraHarness;
let limiter: RateLimitService;
let redis: RedisService;

/** Redis's own time in milliseconds (the clock that leases and counters are judged on), read with TIME. */
async function redisNowMs(): Promise<number> {
  const [seconds, micros] = await redis.cache.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}
let keys: CacheKeys;

beforeAll(async () => {
  harness = await createInfra();
  limiter = harness.get(RateLimitService);
  redis = harness.get(RedisService);
  keys = harness.get(CacheKeys);
});
afterAll(async () => {
  const cache = harness.get(CacheService);
  for (const name of [...Object.keys(RATE_LIMITERS), 'semaphore']) {
    await cache.delByPrefix(keys.prefix('ratelimit', name, 'rltest-'));
  }
  // Sign-in keys are hashes (no readable prefix); the test database is ours alone.
  await cache.delByPrefix(keys.prefix('ratelimit', 'sign-in'));
  await harness.close();
});

/** A caller key that no other test uses. */
const caller = () => `rltest-${randomUUID()}`;

describe('consume', () => {
  it('allows the budget and then refuses, counting down and telling when to come back', async () => {
    const key = caller();
    const limit = RATE_LIMITERS.token.points; // 30 per minute
    for (let used = 1; used <= limit; used++) {
      const result = await limiter.consume('token', key);
      expect(result, `call ${used}`).toEqual({ allowed: true, remaining: limit - used, limit, retryAfterSeconds: 0 });
    }
    const refused = await limiter.consume('token', key);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.limit).toBe(limit);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMITERS.token.windowSeconds);
    // Still refused on the next call; the budget is not refilled by asking.
    expect((await limiter.consume('token', key)).allowed).toBe(false);
  });

  it('counts per key: one caller using up its budget does not affect another', async () => {
    const [a, b] = [caller(), caller()];
    for (let i = 0; i < RATE_LIMITERS.token.points; i++) await limiter.consume('token', a);
    expect((await limiter.consume('token', a)).allowed).toBe(false);
    expect((await limiter.consume('token', b)).allowed).toBe(true);
  });

  it('counts per limiter: the same key has a separate budget in each limiter', async () => {
    const key = caller();
    for (let i = 0; i < RATE_LIMITERS.token.points; i++) await limiter.consume('token', key);
    expect((await limiter.consume('token', key)).allowed).toBe(false);
    expect((await limiter.consume('ip', key)).allowed).toBe(true);
  });

  it('charges several points at once', async () => {
    const key = caller();
    const first = await limiter.consume('token', key, 25);
    expect(first.remaining).toBe(5);
    expect((await limiter.consume('token', key, 5)).remaining).toBe(0);
    expect((await limiter.consume('token', key, 1)).allowed).toBe(false);
  });

  it('counts a refused call against the budget too (hammering an exhausted key does not help)', async () => {
    const key = caller();
    expect((await limiter.consume('token', key, 25)).allowed).toBe(true);
    expect((await limiter.consume('token', key, 6)).allowed).toBe(false); // more than the 5 left
    expect((await limiter.consume('token', key, 1)).allowed, 'the refused 6 points were counted').toBe(false);
  });

  it('stores the counter on the cache Redis under gsm:{env}:ratelimit:{limiter}:{key}, with a TTL of at most the window', async () => {
    const key = caller();
    await limiter.consume('token', key);
    const redisKey = `${keys.rateLimit('token')}:${key}`;
    expect(redisKey.startsWith('gsm:test:ratelimit:token:rltest-')).toBe(true);
    expect(await redis.cache.get(redisKey)).toBe('1');
    const ttl = await redis.cache.pttl(redisKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RATE_LIMITERS.token.windowSeconds * 1000);
  });

  it('counts again from zero when the window ends', async () => {
    const key = caller();
    for (let i = 0; i < RATE_LIMITERS.token.points; i++) await limiter.consume('token', key);
    expect((await limiter.consume('token', key)).allowed).toBe(false);
    // The counter lives under a key that Redis drops when its TTL (at most the window, asserted above) ends. Dropping it now
    // is the state at the end of the window; the test does not wait for Redis's own clock.
    await redis.cache.del(`${keys.rateLimit('token')}:${key}`);
    const again = await limiter.consume('token', key);
    expect(again).toMatchObject({ allowed: true, remaining: RATE_LIMITERS.token.points - 1 });
  });

  it('rejects nonsense input instead of limiting it', async () => {
    await expectRejection(limiter.consume('token', ''), RangeError);
    await expectRejection(limiter.consume('token', 'x'.repeat(257)), RangeError);
    await expectRejection(limiter.consume('token', caller(), 0), RangeError);
    await expectRejection(limiter.consume('token', caller(), 1.5), RangeError);
    await expectRejection(limiter.consume('token', caller(), 1, { limit: 0 }), RangeError);
  });

  it('refuses a call that costs more than the whole budget', async () => {
    const result = await limiter.consume('token', caller(), RATE_LIMITERS.token.points + 1);
    expect(result.allowed).toBe(false);
  });
});

describe('per-key limits (API keys, suppliers)', () => {
  it('replaces the limiter points for this key and reports the limit that applied', async () => {
    const key = caller();
    for (let used = 1; used <= 3; used++) {
      expect(await limiter.consume('api-key', key, 1, { limit: 3 })).toEqual({
        allowed: true,
        remaining: 3 - used,
        limit: 3,
        retryAfterSeconds: 0,
      });
    }
    const refused = await limiter.consume('api-key', key, 1, { limit: 3 });
    expect(refused).toMatchObject({ allowed: false, limit: 3, remaining: 0 });
    // Another key of the same limiter has its own, larger limit.
    const generous = caller();
    for (let i = 0; i < 100; i++)
      expect((await limiter.consume('api-key', generous, 1, { limit: 100 })).allowed).toBe(true);
    expect((await limiter.consume('api-key', generous, 1, { limit: 100 })).allowed).toBe(false);
  });

  it('keeps the count when staff change the limit: raising it lets the key continue, lowering it takes effect at once', async () => {
    const key = caller();
    for (let i = 0; i < 3; i++) await limiter.consume('api-key', key, 1, { limit: 3 });
    expect((await limiter.consume('api-key', key, 1, { limit: 3 })).allowed).toBe(false);
    expect((await limiter.consume('api-key', key, 1, { limit: 10 })).allowed).toBe(true); // 5th call of 10
    expect((await limiter.consume('api-key', key, 1, { limit: 4 })).allowed).toBe(false); // 6th call, limit now 4
  });

  it('uses the default of the limiter when the key has no limit of its own', async () => {
    const result = await limiter.consume('supplier', caller());
    expect(result.limit).toBe(RATE_LIMITERS.supplier.points);
  });
});

describe('sign-in lock-out (email + IP)', () => {
  const email = () => `rltest-${randomUUID()}@example.com`;

  it('allows five attempts, refuses the sixth and keeps refusing for the lock-out time', async () => {
    const key = RateLimitService.compositeKey(email(), '203.0.113.9');
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await limiter.consume('sign-in', key)).allowed, `attempt ${attempt}`).toBe(true);
    }
    const sixth = await limiter.consume('sign-in', key);
    expect(sixth.allowed).toBe(false);
    // The lock lasts blockSeconds (15 minutes), not just the rest of the window.
    expect(sixth.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMITERS['sign-in'].blockSeconds);
    const seventh = await limiter.consume('sign-in', key);
    expect(seventh.allowed).toBe(false);
    expect(seventh.retryAfterSeconds).toBeGreaterThan(14 * 60);
  });

  it('locks only that email + IP pair: the same email from another address, and other emails, are unaffected', async () => {
    const victim = email();
    const attacker = RateLimitService.compositeKey(victim, '198.51.100.7');
    for (let i = 0; i < 6; i++) await limiter.consume('sign-in', attacker);
    expect((await limiter.consume('sign-in', attacker)).allowed).toBe(false);
    expect((await limiter.consume('sign-in', RateLimitService.compositeKey(victim, '192.0.2.50'))).allowed).toBe(true);
    expect((await limiter.consume('sign-in', RateLimitService.compositeKey(email(), '198.51.100.7'))).allowed).toBe(
      true,
    );
  });

  it('is cleared by reset, which is what a successful sign-in does', async () => {
    const key = RateLimitService.compositeKey(email(), '203.0.113.10');
    for (let i = 0; i < 4; i++) await limiter.consume('sign-in', key);
    await limiter.reset('sign-in', key);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await limiter.consume('sign-in', key)).allowed, `attempt ${attempt} after reset`).toBe(true);
    }
  });

  it('reset lifts a lock-out too', async () => {
    const key = RateLimitService.compositeKey(email(), '203.0.113.11');
    for (let i = 0; i < 6; i++) await limiter.consume('sign-in', key);
    expect((await limiter.consume('sign-in', key)).allowed).toBe(false);
    await limiter.reset('sign-in', key);
    expect((await limiter.consume('sign-in', key)).allowed).toBe(true);
  });

  it('keeps the email out of Redis: the key is a hash, the same for any spelling of the address', async () => {
    const address = email();
    const key = RateLimitService.compositeKey(address, '203.0.113.12');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('rltest');
    expect(RateLimitService.compositeKey(address.toUpperCase(), ' 203.0.113.12 ')).toBe(key);
    expect(RateLimitService.compositeKey(address, '203.0.113.13')).not.toBe(key);
    // "a|b" + "c" must not collide with "a" + "b|c"
    expect(RateLimitService.compositeKey('a|b', 'c')).not.toBe(RateLimitService.compositeKey('a', 'b|c'));
    await limiter.consume('sign-in', key);
    const stored = await redis.cache.keys(`${keys.rateLimit('sign-in')}:${key}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain('@');
  });
});

describe('enforce and the RATE_LIMITED helper', () => {
  it('returns the result while the budget lasts and throws 429 RATE_LIMITED with Retry-After when it is used up', async () => {
    const key = caller();
    for (let i = 0; i < 3; i++) expect((await limiter.enforce('api-key', key, 1, { limit: 3 })).allowed).toBe(true);
    try {
      await limiter.enforce('api-key', key, 1, { limit: 3 });
      throw new Error('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const refusal = error as AppError;
      expect(refusal.code).toBe('RATE_LIMITED');
      expect(refusal.status).toBe(429);
      expect(refusal.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(refusal.detail).toContain('Try again in');
    }
  });

  it('builds the error with a whole number of seconds, at least one', () => {
    expect(rateLimitedError(0).retryAfterSeconds).toBe(1);
    expect(rateLimitedError(0.2).retryAfterSeconds).toBe(1);
    expect(rateLimitedError(2.1).retryAfterSeconds).toBe(3);
    expect(rateLimitedError(1).detail).toBe('Too many requests. Try again in 1 second.');
    expect(rateLimitedError(30).detail).toBe('Too many requests. Try again in 30 seconds.');
    expect(rateLimitedError(30).status).toBe(429);
  });

  it('counts refusals per limiter in Prometheus', async () => {
    const key = caller();
    const before = metricValue(await harness.get(MetricsService).render(), 'rate_limit_denied_total', {
      limiter: 'api-key',
    });
    for (let i = 0; i < 4; i++) await limiter.consume('api-key', key, 1, { limit: 2 });
    const after = metricValue(await harness.get(MetricsService).render(), 'rate_limit_denied_total', {
      limiter: 'api-key',
    });
    expect(after - before).toBe(2);
  });
});

// Every route needs a contract: the guard dispatcher refuses a route without one (decision 018).
const limitedRoute = defineRoute({
  key: 'GET /t/limited',
  summary: 'A route that allows two calls per caller',
  tags: ['test'],
  surface: 'system',
  access: 'public',
  query: z.object({ caller: z.string() }),
  success: { status: 200, schema: z.object({ remaining: z.number() }) },
  errors: ['RATE_LIMITED', 'VALIDATION_FAILED'],
});

@Controller()
class LimitedController {
  constructor(private readonly limits: RateLimitService) {}

  @Route(limitedRoute)
  async limited(@Query() query: QueryOf<typeof limitedRoute>): Promise<{ remaining: number }> {
    const result = await this.limits.enforce('api-key', query.caller, 1, { limit: 2 });
    return { remaining: result.remaining };
  }
}

describe('through HTTP', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp({ controllers: [LimitedController] });
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers 429 problem+json with a Retry-After header the console can read', async () => {
    const who = caller();
    const get = () => app.app.inject({ method: 'GET', url: `/t/limited?caller=${who}` });
    expect((await get()).json()).toEqual({ remaining: 1 });
    expect((await get()).json()).toEqual({ remaining: 0 });
    const refused = await get();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(refused.json()).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      requestId: refused.headers['x-request-id'],
    });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.json().detail).toContain(`${retryAfter} second`);
  });
});

describe('semaphore (per-supplier concurrency)', () => {
  const name = () => `rltest-${randomUUID()}`;

  it('hands out at most max leases at a time and gives a place back on release', async () => {
    const semaphore = name();
    const a = await limiter.acquire(semaphore, 2, 10_000);
    const b = await limiter.acquire(semaphore, 2, 10_000);
    const c = await limiter.acquire(semaphore, 2, 10_000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c, 'the third caller waits its turn').toBeNull();
    expect(a!.token).not.toBe(b!.token);
    await limiter.release(a!);
    const d = await limiter.acquire(semaphore, 2, 10_000);
    expect(d).not.toBeNull();
    expect(await limiter.acquire(semaphore, 2, 10_000)).toBeNull();
    await limiter.release(b!);
    await limiter.release(d!);
    expect(await redis.cache.zcard(keys.semaphore(semaphore))).toBe(0);
  });

  it('frees a place by itself when the lease expires (the holder crashed)', async () => {
    const semaphore = name();
    const before = await redisNowMs();
    const crashed = await limiter.acquire(semaphore, 1, 250);
    const after = await redisNowMs();
    expect(crashed).not.toBeNull();
    expect(await limiter.acquire(semaphore, 1, 250)).toBeNull();
    // A lease is scored with its expiry on Redis's clock (TIME + ttl), which is what frees the place...
    const expiry = Number(await redis.cache.zscore(keys.semaphore(semaphore), crashed!.token));
    expect(expiry).toBeGreaterThanOrEqual(before + 250);
    expect(expiry).toBeLessThanOrEqual(after + 250);
    // ...so a lease whose expiry has passed (moved into the past, instead of waiting for Redis's clock) frees it.
    await redis.cache.zadd(keys.semaphore(semaphore), 'XX', before - 1, crashed!.token);
    const next = await limiter.acquire(semaphore, 1, 10_000);
    expect(next).not.toBeNull();
    await limiter.release(next!);
  });

  it("does not let a late release of an expired lease free someone else's place", async () => {
    const semaphore = name();
    const slow = await limiter.acquire(semaphore, 1, 200);
    // The slow holder's lease expires (moved into the past) and another caller takes the place.
    await redis.cache.zadd(keys.semaphore(semaphore), 'XX', (await redisNowMs()) - 1, slow!.token);
    const current = await limiter.acquire(semaphore, 1, 10_000);
    expect(current).not.toBeNull();
    await limiter.release(slow!); // the slow holder finally finishes
    expect(await limiter.acquire(semaphore, 1, 10_000), 'the current holder still owns the only place').toBeNull();
    await limiter.release(current!);
  });

  it('is safe under concurrency: 40 simultaneous callers for 5 places get exactly 5', async () => {
    const semaphore = name();
    const leases = await Promise.all(Array.from({ length: 40 }, () => limiter.acquire(semaphore, 5, 10_000)));
    expect(leases.filter((lease) => lease !== null)).toHaveLength(5);
    expect(await redis.cache.zcard(keys.semaphore(semaphore))).toBe(5);
    await Promise.all(leases.filter((lease) => lease !== null).map((lease) => limiter.release(lease)));
  });

  it('keeps the key alive as long as the longest lease and always gives it a TTL', async () => {
    const semaphore = name();
    const short = await limiter.acquire(semaphore, 3, 1_000);
    const long = await limiter.acquire(semaphore, 3, 20_000);
    const ttl = await redis.cache.pttl(keys.semaphore(semaphore));
    expect(ttl).toBeGreaterThan(1_000);
    expect(ttl).toBeLessThanOrEqual(20_000);
    await limiter.release(short!);
    await limiter.release(long!);
  });

  it('rejects a max or lease length that makes no sense', async () => {
    await expectRejection(limiter.acquire(name(), 0, 1000), RangeError);
    await expectRejection(limiter.acquire(name(), 1.5, 1000), RangeError);
    await expectRejection(limiter.acquire(name(), 1, 0), RangeError);
    await expectRejection(limiter.acquire('bad:name', 1, 1000), /must match/);
  });

  it('release never throws, even when Redis is gone', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      expect(
        await down.get(RateLimitService).release({ name: 'x', token: 't', key: 'gsm:test:semaphore:x' }),
      ).toBeUndefined();
    } finally {
      await down.close();
    }
  });
});

describe('while the cache Redis is down', () => {
  it('keeps limiting with an in-memory limiter of the same size, instead of switching the limit off', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      const service = down.get(RateLimitService);
      const key = caller();
      for (let i = 0; i < 3; i++) expect((await service.consume('api-key', key, 1, { limit: 3 })).allowed).toBe(true);
      const refused = await service.consume('api-key', key, 1, { limit: 3 });
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      await down.close();
    }
  });

  it('keeps the sign-in lock-out working per process', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      const service = down.get(RateLimitService);
      const key = RateLimitService.compositeKey('someone@example.com', '203.0.113.99');
      const results = [];
      for (let i = 0; i < 7; i++) results.push((await service.consume('sign-in', key)).allowed);
      expect(results).toEqual([true, true, true, true, true, false, false]);
    } finally {
      await down.close();
    }
  });

  it('answers fast, without waiting for the dead connection', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      const started = performance.now();
      await down.get(RateLimitService).consume('ip', caller());
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await down.close();
    }
  });

  it('refuses to hand out a semaphore place it cannot count (the dispatch job retries later)', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      await expectRejection(down.get(RateLimitService).acquire('supplier-1', 2, 1000));
    } finally {
      await down.close();
    }
  });
});
