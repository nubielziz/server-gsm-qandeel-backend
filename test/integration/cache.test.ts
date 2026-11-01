// Integration tests of CacheService (decision 022) on the test cache Redis (database 1): cache-aside, TTL jitter, stampede
// protection inside one process and across two (the lock), stale-while-revalidate, negative caching, deletion by key and by
// prefix, version keys, values over 100 KB, hit/miss metrics, and the fallback to the loader while Redis is down.
// Freshness is counted on the injected clock (decision 031), so TTLs and stale windows pass by moving a TestClock; what Redis
// itself does with a TTL is asserted by reading it back (PTTL), never by waiting for it. The only real waits are the lock
// tests, which are about the polling and the deadline of the cross-process lock.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type CacheKey, CacheKeys, CacheService, MAX_CACHED_VALUE_BYTES } from '../../src/infra/cache';
import { MetricsService } from '../../src/infra/metrics';
import { RedisService } from '../../src/infra/redis';
import { TestClock } from '../support/clock';
import { type InfraHarness, createInfra, deadRedisUrl, eventually } from '../support/infra';
import { metricValue } from '../support/metrics';
import { expectRejection } from '../support/rejection';

/** The clock of every service in this file: freshness and stale windows move when the test moves it. */
const clock = new TestClock();
let harness: InfraHarness;
let cache: CacheService;
let keys: CacheKeys;
let redis: RedisService;
const FAMILY = 'infra:test';

beforeAll(async () => {
  harness = await createInfra({ clock });
  cache = harness.get(CacheService);
  keys = harness.get(CacheKeys);
  redis = harness.get(RedisService);
});
afterAll(async () => {
  await cache.delByPrefix(keys.prefix('infra', 'test'));
  await cache.delByPrefix(keys.prefix('cache', 'version', 'cachetest'));
  await harness.close();
});

/** A key of the `infra:test` family that no other test uses. */
const newKey = (id: string = randomUUID()): CacheKey => `${keys.keyspace}infra:test:${id}` as CacheKey;

/** A promise that the test settles by hand, to hold a loader in the middle of its work. */
function gate() {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A loader that counts its calls and, when given a gate, does not answer until the test opens it. */
function counted<T>(value: T, hold?: { promise: Promise<void> }) {
  const state = { calls: 0 };
  return {
    state,
    loader: async (): Promise<T> => {
      state.calls++;
      if (hold) await hold.promise;
      return value;
    },
  };
}

const metrics = async (name: string, labels: Record<string, string> = { family: FAMILY }) =>
  metricValue(await harness.get(MetricsService).render(), name, labels);

describe('getOrLoad', () => {
  it('loads on a miss, stores the value, and answers the next call from Redis', async () => {
    const key = newKey();
    const source = counted({ id: 7, name: 'IMEI check', prices: [1.5, 2], nested: { ok: true, none: null } });
    const first = await cache.getOrLoad(key, 60, source.loader);
    const second = await cache.getOrLoad(key, 60, source.loader);
    expect(first).toEqual({ id: 7, name: 'IMEI check', prices: [1.5, 2], nested: { ok: true, none: null } });
    expect(second).toEqual(first);
    expect(source.state.calls).toBe(1);
  });

  it('always sets a TTL, spread by +-15 % around the requested one', async () => {
    const ttls: number[] = [];
    for (let i = 0; i < 40; i++) {
      const key = newKey();
      await cache.getOrLoad(key, 100, () => Promise.resolve(i));
      const ttl = await redis.cache.pttl(key);
      expect(ttl, 'a cache key must never be stored without a TTL').toBeGreaterThan(0);
      ttls.push(ttl);
    }
    expect(Math.min(...ttls)).toBeGreaterThanOrEqual(85_000 - 1_000);
    expect(Math.max(...ttls)).toBeLessThanOrEqual(115_000);
    expect(new Set(ttls).size, 'the TTLs are spread, not identical').toBeGreaterThan(10);
  });

  it('counts hits and misses per key family', async () => {
    const hitsBefore = await metrics('cache_hits_total');
    const missesBefore = await metrics('cache_misses_total');
    const key = newKey();
    const source = counted('x');
    await cache.getOrLoad(key, 60, source.loader);
    await cache.getOrLoad(key, 60, source.loader);
    await cache.getOrLoad(key, 60, source.loader);
    expect(await metrics('cache_misses_total')).toBe(missesBefore + 1);
    expect(await metrics('cache_hits_total')).toBe(hitsBefore + 2);
  });

  it('serves the value to every caller of one load: 50 concurrent calls, one load (stampede in one process)', async () => {
    const key = newKey();
    const hold = gate();
    const source = counted({ expensive: true }, hold);
    const pending = Array.from({ length: 50 }, () => cache.getOrLoad(key, 60, source.loader));
    await eventually(() => (source.state.calls > 0 ? true : undefined));
    hold.open();
    const results = await Promise.all(pending);
    expect(source.state.calls).toBe(1);
    expect(results).toHaveLength(50);
    for (const result of results) expect(result).toEqual({ expensive: true });
  });

  it('shares the failure of a load with every waiting caller and caches nothing', async () => {
    const key = newKey();
    let calls = 0;
    const hold = gate();
    const failing = async (): Promise<string> => {
      calls++;
      await hold.promise;
      throw new Error('database is down');
    };
    const pending = Array.from({ length: 10 }, () => cache.getOrLoad(key, 60, failing));
    await eventually(() => (calls > 0 ? true : undefined));
    hold.open();
    const outcomes = await Promise.allSettled(pending);
    expect(calls).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason.message).toBe('database is down');
    }
    expect(await redis.cache.exists(key)).toBe(0);
    // The next call tries again.
    const recovered = counted('back');
    expect(await cache.getOrLoad(key, 60, recovered.loader)).toBe('back');
  });

  it('does not cache null or undefined unless negative caching is asked for', async () => {
    for (const nothing of [null, undefined]) {
      const key = newKey();
      const source = counted(nothing);
      await cache.getOrLoad(key, 60, source.loader);
      await cache.getOrLoad(key, 60, source.loader);
      expect(source.state.calls).toBe(2);
      expect(await redis.cache.exists(key)).toBe(0);
    }
  });

  it('caches values that are falsy but real (0, false, empty string)', async () => {
    for (const value of [0, false, '']) {
      const key = newKey();
      const source = counted(value);
      expect(await cache.getOrLoad(key, 60, source.loader)).toBe(value);
      expect(await cache.getOrLoad(key, 60, source.loader)).toBe(value);
      expect(source.state.calls, JSON.stringify(value)).toBe(1);
    }
  });

  it('treats an unreadable entry as a miss and overwrites it', async () => {
    const key = newKey();
    await redis.cache.set(key, 'this is not an envelope', 'PX', 30_000);
    const errorsBefore = await metrics('cache_errors_total', { family: FAMILY, operation: 'decode' });
    const source = counted('fresh');
    expect(await cache.getOrLoad(key, 60, source.loader)).toBe('fresh');
    expect(await cache.getOrLoad(key, 60, source.loader)).toBe('fresh');
    expect(source.state.calls).toBe(1);
    expect(await metrics('cache_errors_total', { family: FAMILY, operation: 'decode' })).toBe(errorsBefore + 1);
  });

  it('refuses keys that were not built by CacheKeys, and TTLs and options that make no sense', async () => {
    const source = counted(1);
    await expectRejection(cache.getOrLoad('some:hand:made:key' as CacheKey, 60, source.loader), RangeError);
    for (const ttl of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 40 * 24 * 3600]) {
      await expectRejection(cache.getOrLoad(newKey(), ttl, source.loader), RangeError, String(ttl));
    }
    await expectRejection(cache.getOrLoad(newKey(), 60, source.loader, { lockMs: 0 }), RangeError);
    await expectRejection(cache.getOrLoad(newKey(), 60, source.loader, { negativeTtlSeconds: -1 }), RangeError);
    expect(source.state.calls).toBe(0);
  });
});

describe('values over 100 KB', () => {
  it('are returned but not cached, and counted as an error', async () => {
    const key = newKey();
    const big = 'x'.repeat(MAX_CACHED_VALUE_BYTES + 1);
    const source = counted(big);
    const errorsBefore = await metrics('cache_errors_total', { family: FAMILY, operation: 'too_large' });
    expect(await cache.getOrLoad(key, 60, source.loader)).toBe(big);
    expect(await cache.getOrLoad(key, 60, source.loader)).toBe(big);
    expect(source.state.calls).toBe(2);
    expect(await redis.cache.exists(key)).toBe(0);
    expect(await metrics('cache_errors_total', { family: FAMILY, operation: 'too_large' })).toBe(errorsBefore + 2);
  });

  it('are accepted up to exactly 100 KB', async () => {
    const key = newKey();
    const exact = 'x'.repeat(MAX_CACHED_VALUE_BYTES - 2);
    const source = counted(exact);
    await cache.getOrLoad(key, 60, source.loader);
    await cache.getOrLoad(key, 60, source.loader);
    expect(source.state.calls).toBe(1);
  });
});

describe('stampede protection across processes (lockMs)', () => {
  it('loads once for 50 callers spread over two processes that share one Redis', async () => {
    const other = await createInfra({ clock });
    try {
      const second = other.get(CacheService);
      const key = newKey();
      const hold = gate();
      const source = counted({ price: 12.5 }, hold);
      const calls = [
        ...Array.from({ length: 25 }, () => cache.getOrLoad(key, 60, source.loader, { lockMs: 3_000 })),
        ...Array.from({ length: 25 }, () => second.getOrLoad(key, 60, source.loader, { lockMs: 3_000 })),
      ];
      // Real wait: the process without the lock polls Redis for the value (25 ms polls) until the holder has stored it.
      await eventually(async () => ((await redis.cache.exists(keys.lock(key))) === 1 ? true : undefined));
      hold.open();
      const results = await Promise.all(calls);
      expect(source.state.calls).toBe(1);
      for (const result of results) expect(result).toEqual({ price: 12.5 });
      // The lock does not outlive the load.
      expect(await redis.cache.exists(keys.lock(key))).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('lets the other process load itself when the lock holder never stores a value (it failed or is too slow)', async () => {
    const key = newKey();
    // Someone else holds the lock for a long time and will never store anything.
    await redis.cache.set(keys.lock(key), 'a-process-that-died', 'PX', 5_000);
    const source = counted('mine');
    // Real wait of about 120 ms: the lock deadline of the waiting process is the behaviour under test (monotonic time).
    const started = performance.now();
    expect(await cache.getOrLoad(key, 60, source.loader, { lockMs: 120 })).toBe('mine');
    const waited = performance.now() - started;
    expect(source.state.calls).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(1_500);
    // The foreign lock is left alone: it was not ours to release.
    expect(await redis.cache.exists(keys.lock(key))).toBe(1);
    await redis.cache.del(keys.lock(key));
  });

  it('stops waiting as soon as the holder releases the lock without a value (a null result is not cached)', async () => {
    const other = await createInfra({ clock });
    try {
      const key = newKey();
      const holder = other.get(CacheService);
      const hold = gate();
      const nothing = counted(null, hold);
      const mine = counted('second try');
      const first = holder.getOrLoad(key, 60, nothing.loader, { lockMs: 5_000 });
      // Wait until the holder really has the lock and is loading.
      await eventually(async () => ((await redis.cache.exists(keys.lock(key))) === 1 ? true : undefined));
      const started = performance.now();
      const waiting = cache.getOrLoad(key, 60, mine.loader, { lockMs: 5_000 });
      // The holder finishes with nothing to cache while the other process waits for it (a few event loop turns later).
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
      hold.open();
      const result = await waiting;
      expect(await first).toBeNull();
      expect(result).toBe('second try');
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      await other.close();
    }
  });
});

describe('negative caching', () => {
  it('remembers "nothing there" for the negative TTL and answers null from the cache', async () => {
    const key = newKey();
    const source = counted<string | null>(null);
    const options = { negativeTtlSeconds: 30 };
    expect(await cache.getOrLoad(key, 600, source.loader, options)).toBeNull();
    expect(await cache.getOrLoad(key, 600, source.loader, options)).toBeNull();
    expect(await cache.getOrLoad(key, 600, source.loader, options)).toBeNull();
    expect(source.state.calls).toBe(1);
    const ttl = await redis.cache.pttl(key);
    expect(ttl).toBeGreaterThan(30_000 * 0.85 - 1_000);
    expect(ttl).toBeLessThanOrEqual(30_000 * 1.15);
  });

  it('forgets it after the negative TTL, and a real value then takes over with the normal TTL', async () => {
    const key = newKey();
    let answer: string | null = null;
    let calls = 0;
    const loader = () => {
      calls++;
      return Promise.resolve(answer);
    };
    expect(await cache.getOrLoad(key, 600, loader, { negativeTtlSeconds: 0.2 })).toBeNull();
    const negativeTtl = await redis.cache.pttl(key);
    expect(negativeTtl, 'the "nothing" entry got the negative TTL, not the normal one').toBeGreaterThan(0);
    expect(negativeTtl).toBeLessThanOrEqual(230);
    // Past the negative TTL by the injected clock (its jitter is at most +15 %).
    clock.advance(300);
    answer = 'now it exists';
    expect(await cache.getOrLoad(key, 600, loader, { negativeTtlSeconds: 0.2 })).toBe('now it exists');
    expect(calls).toBe(2);
    expect(await redis.cache.pttl(key)).toBeGreaterThan(400_000);
  });
});

describe('stale-while-revalidate', () => {
  it('answers a stale value at once, refreshes once in the background, then serves the new value', async () => {
    const key = newKey();
    // The refresh waits for the gate, so what the callers see does not depend on timing.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let version = 0;
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls > 1) await gate;
      return ++version;
    };
    const options = { staleWhileRevalidate: 30 };
    expect(await cache.getOrLoad(key, 0.3, loader, options)).toBe(1);
    clock.advance(700); // past the 0.3 s TTL (+-15 %), inside the stale window (the key itself lives 30 s longer)

    // The refresh is still waiting at the gate, so only a stale value can answer, and it answers at once.
    expect(await cache.getOrLoad(key, 0.3, loader, options), 'the old value is served while the refresh runs').toBe(1);
    // More stale reads do not start more refreshes.
    const during = await Promise.all(Array.from({ length: 10 }, () => cache.getOrLoad(key, 0.3, loader, options)));
    expect(during).toEqual(Array(10).fill(1));
    expect(calls, 'one load for the first value and exactly one background refresh').toBe(2);

    openGate();
    const refreshed = await eventually(async () =>
      (await cache.getOrLoad(key, 0.3, loader, options)) === 2 ? 2 : undefined,
    );
    expect(refreshed).toBe(2);
    expect(calls, 'serving the new value did not load again').toBe(2);
  });

  it('keeps the key alive for the TTL plus the stale window', async () => {
    const key = newKey();
    await cache.getOrLoad(key, 10, () => Promise.resolve('v'), { staleWhileRevalidate: 50 });
    const ttl = await redis.cache.pttl(key);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_500);
  });

  it('keeps serving the old value when the refresh fails', async () => {
    const key = newKey();
    let calls = 0;
    const loader = () => {
      calls++;
      return calls > 1 ? Promise.reject(new Error('supplier down')) : Promise.resolve('old');
    };
    const options = { staleWhileRevalidate: 30 };
    expect(await cache.getOrLoad(key, 0.2, loader, options)).toBe('old');
    clock.advance(600);
    expect(await cache.getOrLoad(key, 0.2, loader, options)).toBe('old');
    // The refresh runs in the background and fails.
    await eventually(() => (calls >= 2 ? true : undefined));
    expect(await cache.getOrLoad(key, 0.2, loader, options)).toBe('old');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('without the option an expired entry is a plain miss', async () => {
    const key = newKey();
    const source = counted('v');
    await cache.getOrLoad(key, 0.2, source.loader);
    clock.advance(800);
    await cache.getOrLoad(key, 0.2, source.loader);
    expect(source.state.calls).toBe(2);
  });
});

describe('deleting', () => {
  it('del removes keys and says how many existed', async () => {
    const [a, b, c] = [newKey(), newKey(), newKey()];
    await cache.getOrLoad(a, 60, () => Promise.resolve(1));
    await cache.getOrLoad(b, 60, () => Promise.resolve(2));
    expect(await cache.del(a, b, c)).toBe(2);
    expect(await redis.cache.exists(a, b)).toBe(0);
    expect(await cache.del()).toBe(0);
    const source = counted(3);
    await cache.getOrLoad(a, 60, source.loader);
    expect(source.state.calls).toBe(1);
  });

  it('a del while a load is running stops that load from storing its (older) value', async () => {
    const key = newKey();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slow = async () => {
      calls++;
      await gate;
      return 'read before the change';
    };
    const pending = cache.getOrLoad(key, 60, slow);
    await eventually(() => (calls > 0 ? true : undefined)); // the load is running
    await cache.del(key); // the writer committed and invalidated
    release();
    expect(await pending).toBe('read before the change'); // the caller who started before the change still gets its answer
    expect(await redis.cache.exists(key), 'but it must not be stored').toBe(0);
    expect(await cache.getOrLoad(key, 60, () => Promise.resolve('read after the change'))).toBe(
      'read after the change',
    );
    expect(calls).toBe(1);
  });

  it('a caller arriving after a del does not join the older load: it loads fresh data', async () => {
    const key = newKey();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const older = cache.getOrLoad(key, 60, async () => {
      started = true;
      await gate;
      return 'read before the change';
    });
    await eventually(() => (started ? true : undefined)); // the older load is running
    await cache.del(key); // the writer committed and invalidated
    const newer = cache.getOrLoad(key, 60, () => Promise.resolve('read after the change'));
    expect(await newer).toBe('read after the change');
    release();
    expect(await older).toBe('read before the change');
    expect(await cache.getOrLoad(key, 60, () => Promise.resolve('unused'))).toBe('read after the change');
  });

  it('delByPrefix removes a whole group by scanning, in batches, and nothing else', async () => {
    const group = randomUUID();
    const inGroup = Array.from({ length: 1_200 }, (_, i) => newKey(`${group}-${i}`));
    const outside = [newKey(), newKey()];
    const pipeline = redis.cache.pipeline();
    for (const key of [...inGroup, ...outside]) pipeline.set(key, '{"v":1,"f":9999999999999}', 'PX', 60_000);
    await pipeline.exec();
    const removed = await cache.delByPrefix(keys.prefix('infra', 'test', group));
    expect(removed).toBe(1_200);
    expect(await redis.cache.exists(...inGroup.slice(0, 50))).toBe(0);
    expect(await redis.cache.exists(...outside)).toBe(2);
  });

  it('delByPrefix on an empty group removes nothing, and refuses a prefix not built by CacheKeys', async () => {
    expect(await cache.delByPrefix(keys.prefix('infra', 'test', `nothing-${randomUUID()}`))).toBe(0);
    // A prefix without module and entity would delete a whole keyspace.
    for (const bad of [
      'gsm:test:',
      'gsm:test:infra:',
      'gsm:test:infra',
      'other:infra:test:',
      '',
      'gsm:production:infra:test:',
    ]) {
      await expectRejection(cache.delByPrefix(bad as never), RangeError, bad);
    }
  });
});

describe('version keys', () => {
  const name = () => `cachetest-${randomUUID()}`;

  it('give a base key a version suffix that bumpVersion changes', async () => {
    const version = name();
    const base = newKey('catalog-list');
    const before = await cache.versioned(version, base);
    expect(before).toMatch(new RegExp(`^${base}:v\\d+$`));
    expect(await cache.versioned(version, base), 'stable until bumped').toBe(before);

    const source = counted('list v1');
    await cache.getOrLoad(before, 60, source.loader);
    await cache.getOrLoad(await cache.versioned(version, base), 60, source.loader);
    expect(source.state.calls).toBe(1);

    const bumped = await cache.bumpVersion(version);
    const after = await cache.versioned(version, base);
    expect(after).not.toBe(before);
    expect<string>(after).toBe(`${base}:v${bumped}`);
    await cache.getOrLoad(after, 60, source.loader);
    expect(source.state.calls, 'the new version is a miss').toBe(2);
    // Old entries are unreachable but not deleted; they expire on their own TTL.
    expect(await redis.cache.exists(before)).toBe(1);
  });

  it('only ever increase, also when bumped twice in the same millisecond', async () => {
    const version = name();
    const numbers: number[] = [];
    for (let i = 0; i < 20; i++) numbers.push(await cache.bumpVersion(version));
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]!, `bump ${i}`).toBeGreaterThan(numbers[i - 1]!);
  });

  it('never go back after the cache evicted the counter: a new counter starts above the old number', async () => {
    const version = name();
    const old = await cache.bumpVersion(version);
    await redis.cache.del(keys.version(version)); // what allkeys-lru does under memory pressure
    const created = await cache.versioned(version, newKey('x'));
    expect(Number(created.split(':v')[1])).toBeGreaterThanOrEqual(old);
    expect(await cache.bumpVersion(version)).toBeGreaterThan(old);
  });

  it('create the counter on first use', async () => {
    const version = name();
    expect(await redis.cache.exists(keys.version(version))).toBe(0);
    await cache.versioned(version, newKey('y'));
    expect(await redis.cache.exists(keys.version(version))).toBe(1);
  });
});

describe('while the cache Redis is down', () => {
  async function downHarness() {
    const dead = await deadRedisUrl();
    return createInfra({ env: { REDIS_CACHE_URL_TEST: dead, REDIS_QUEUE_URL_TEST: dead } });
  }

  it('getOrLoad still answers, by running the loader every time, and counts the errors', async () => {
    const down = await downHarness();
    try {
      const service = down.get(CacheService);
      const key = down.get(CacheKeys).keyspace + 'infra:test:down';
      const source = counted('from the source of truth');
      for (let i = 0; i < 3; i++) {
        expect(await service.getOrLoad(key as CacheKey, 60, source.loader)).toBe('from the source of truth');
      }
      expect(source.state.calls).toBe(3);
      const text = await down.get(MetricsService).render();
      expect(metricValue(text, 'cache_errors_total', { family: FAMILY, operation: 'get' })).toBeGreaterThanOrEqual(3);
    } finally {
      await down.close();
    }
  });

  it('getOrLoad with a lock still answers', async () => {
    const down = await downHarness();
    try {
      const key = (down.get(CacheKeys).keyspace + 'infra:test:down-lock') as CacheKey;
      const source = counted('ok');
      const started = performance.now();
      expect(await down.get(CacheService).getOrLoad(key, 60, source.loader, { lockMs: 2_000 })).toBe('ok');
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      await down.close();
    }
  });

  it('versioned never throws and returns a key that matches nothing', async () => {
    const down = await downHarness();
    try {
      const service = down.get(CacheService);
      const base = (down.get(CacheKeys).keyspace + 'infra:test:down-version') as CacheKey;
      const one = await service.versioned('catalog', base);
      const two = await service.versioned('catalog', base);
      expect(one).not.toBe(two);
      expect(one.startsWith(`${base}:v`)).toBe(true);
    } finally {
      await down.close();
    }
  });

  it('del, delByPrefix and bumpVersion report the failure to the caller', async () => {
    const down = await downHarness();
    try {
      const service = down.get(CacheService);
      const keysOfDown = down.get(CacheKeys);
      await expectRejection(service.del((keysOfDown.keyspace + 'infra:test:a') as CacheKey));
      await expectRejection(service.delByPrefix(keysOfDown.prefix('infra', 'test')));
      await expectRejection(service.bumpVersion('catalog'));
    } finally {
      await down.close();
    }
  });
});
