// Integration tests of the Redis clients (decision 006) on the test instances (database 1 on both roles): constructors never
// connect, both roles connect and report health, the queue producer fails fast and the app still starts while Redis is down,
// the clients recover on their own, shutdown closes every connection, and no credential reaches the log.
import { afterAll, describe, expect, it } from 'bun:test';
import { parseEnv } from '../../src/config';
import { HealthRegistry } from '../../src/infra/health';
import { MetricsService } from '../../src/infra/metrics';
import { RedisService } from '../../src/infra/redis';
import { type InfraHarness, createForwarder, createInfra, deadRedisUrl, eventually } from '../support/infra';
import { metricValue } from '../support/metrics';
import { expectRejection } from '../support/rejection';
import { testInstanceEnv } from '../support/env';

const open: InfraHarness[] = [];
async function infra(...args: Parameters<typeof createInfra>): Promise<InfraHarness> {
  const harness = await createInfra(...args);
  open.push(harness);
  return harness;
}
afterAll(async () => {
  await Promise.all(open.map((harness) => harness.close().catch(() => undefined)));
});

describe('a constructed but not initialised app', () => {
  it('has opened no connection: constructors never connect (the OpenAPI generator relies on it)', async () => {
    const harness = await infra({ init: false });
    const redis = harness.get(RedisService);
    expect(redis.cache.status).toBe('wait');
    expect(redis.queue.status).toBe('wait');
    await harness.moduleRef.init();
    expect(redis.cache.status).toBe('ready');
    expect(redis.queue.status).toBe('ready');
  });
});

describe('with Redis running', () => {
  it('connects both roles to database 1 under their own connection names', async () => {
    const redis = (await infra()).get(RedisService);
    expect(await redis.cache.ping()).toBe('PONG');
    expect(await redis.queue.ping()).toBe('PONG');
    expect(await redis.cache.call('CLIENT', 'GETNAME')).toBe('gsm-cache');
    expect(await redis.queue.call('CLIENT', 'GETNAME')).toBe('gsm-queue-producer');
    for (const client of [redis.cache, redis.queue]) {
      expect(String(await client.call('CLIENT', 'INFO'))).toMatch(/\bdb=1\b/);
    }
  });

  it('keeps the two roles on their own instances: the cache evicts, the queue never does (decision 006)', async () => {
    const harness = await infra();
    const redis = harness.get(RedisService);
    expect(redis.cache.options.port).toBe(Number(new URL(harness.config.redis.cacheUrl).port));
    expect(redis.queue.options.port).toBe(Number(new URL(harness.config.redis.queueUrl).port));
    expect(redis.cache.options.port).not.toBe(redis.queue.options.port);
    const policy = async (client: typeof redis.cache) => (await client.config('GET', 'maxmemory-policy'))[1];
    expect(await policy(redis.cache)).toBe('allkeys-lru');
    expect(await policy(redis.queue)).toBe('noeviction');
  });

  it('registers the redis and redis_queue health indicators, both non-critical, and they pass', async () => {
    const harness = await infra();
    const indicators = harness.get(HealthRegistry).list();
    const byName = Object.fromEntries(indicators.map((indicator) => [indicator.name, indicator]));
    expect(Object.keys(byName).sort()).toEqual(['redis', 'redis_queue', 'storage']);
    for (const name of ['redis', 'redis_queue']) {
      expect(byName[name]?.critical, name).toBe(false);
      expect(await byName[name]!.check(), name).not.toBe(false);
    }
  });

  it('hands out worker connections (maxRetriesPerRequest null) that work and are closed at shutdown', async () => {
    const harness = await infra();
    const redis = harness.get(RedisService);
    const worker = redis.createWorkerConnection();
    expect(worker.status).toBe('wait');
    expect(worker.options.maxRetriesPerRequest).toBeNull();
    await worker.connect();
    expect(await worker.ping()).toBe('PONG');
    expect(await worker.call('CLIENT', 'GETNAME')).toBe('gsm-queue-worker');
    await harness.close();
    expect(worker.status).toBe('end');
  });

  it('closes both clients on shutdown', async () => {
    const harness = await infra();
    const redis = harness.get(RedisService);
    await harness.close();
    expect(redis.cache.status).toBe('end');
    expect(redis.queue.status).toBe('end');
  });

  it('publishes the memory of both roles to Prometheus', async () => {
    const harness = await infra();
    const text = await harness.get(MetricsService).render();
    for (const role of ['cache', 'queue']) {
      expect(metricValue(text, 'redis_memory_used_bytes', { role }), role).toBeGreaterThan(100_000);
      expect(text).toContain(`redis_memory_max_bytes{role="${role}"}`);
    }
    // The cache instance has a memory limit, the queue instance none (compose.yaml).
    expect(metricValue(text, 'redis_memory_max_bytes', { role: 'cache' })).toBeGreaterThan(0);
  });
});

describe('with Redis down at startup', () => {
  it('starts anyway and fast, then fails queue and cache commands at once instead of waiting', async () => {
    const dead = await deadRedisUrl();
    const started = performance.now();
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: dead, REDIS_CACHE_URL_TEST: dead } });
    expect(performance.now() - started).toBeLessThan(2_000);
    const redis = harness.get(RedisService);

    // A producer must not buffer commands in memory or hang the request that enqueues (decision 006).
    for (const [role, client] of [
      ['queue', redis.queue],
      ['cache', redis.cache],
    ] as const) {
      const before = performance.now();
      await expectRejection(
        client.set('gsm:test:probe', '1'),
        /enableOfflineQueue|not writeable|not ready|closed/i,
        role,
      );
      expect(performance.now() - before, role).toBeLessThan(750);
    }
  });

  it('reports both roles as down (the API is then "degraded", not "down")', async () => {
    const dead = await deadRedisUrl();
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: dead, REDIS_CACHE_URL_TEST: dead } });
    const registry = harness.get(HealthRegistry);
    for (const name of ['redis', 'redis_queue']) {
      const indicator = registry.list().find((candidate) => candidate.name === name)!;
      expect(indicator.critical).toBe(false);
      await expectRejection(indicator.check(), undefined, name);
    }
  });

  it('tells the operator once, without credentials', async () => {
    const port = (await deadRedisUrl()).split(':').at(-1)!.split('/')[0];
    const secretUrl = `redis://app:hunter2-secret@127.0.0.1:${port}/1`;
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: secretUrl, REDIS_CACHE_URL_TEST: secretUrl } });
    await eventually(() =>
      harness.logger.lines.some((line) => line.includes('Redis queue error')) ? true : undefined,
    );
    const text = harness.logger.lines.join('\n');
    expect(text).toContain('not reachable yet');
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('app:');
  });

  it('has no memory series while Redis is unreachable, and the scrape still works', async () => {
    const dead = await deadRedisUrl();
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: dead, REDIS_CACHE_URL_TEST: dead } });
    const text = await harness.get(MetricsService).render();
    expect(text).toContain('# HELP redis_memory_used_bytes');
    expect(text).not.toContain('redis_memory_used_bytes{');
  });

  it('connects by itself once Redis is reachable again, and says so', async () => {
    // A forwarder on the dead port, started after the app: stands in for a Redis that comes back.
    const real = new URL(parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    const url = `redis://127.0.0.1:${forwarder.port}/1`;
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: url, REDIS_CACHE_URL_TEST: url } });
    const redis = harness.get(RedisService);
    await expectRejection(redis.queue.ping());

    await forwarder.start();
    try {
      await eventually(
        async () => ((await redis.queue.ping().catch(() => undefined)) === 'PONG' ? true : undefined),
        10_000,
      );
      await eventually(
        async () => ((await redis.cache.ping().catch(() => undefined)) === 'PONG' ? true : undefined),
        10_000,
      );
      expect(harness.logger.lines.some((line) => line.includes('Redis queue is reachable again'))).toBe(true);
    } finally {
      await forwarder.stop();
    }
  });
});

describe('with Redis restarting while the app runs', () => {
  it('fails commands at once while it is away and carries on by itself when it is back', async () => {
    const real = new URL(parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    await forwarder.start();
    const url = `redis://127.0.0.1:${forwarder.port}/1`;
    const harness = await infra({ env: { REDIS_QUEUE_URL_TEST: url, REDIS_CACHE_URL_TEST: url } });
    const redis = harness.get(RedisService);
    try {
      expect(await redis.queue.ping()).toBe('PONG');
      expect(redis.queue.status).toBe('ready');

      await forwarder.stop(); // Redis goes away
      await eventually(() => (redis.queue.status === 'ready' ? undefined : true), 3_000);
      for (const [role, client] of [
        ['queue', redis.queue],
        ['cache', redis.cache],
      ] as const) {
        const before = performance.now();
        await expectRejection(client.set('gsm:test:restart-probe', '1'), undefined, role);
        expect(performance.now() - before, role).toBeLessThan(750);
      }

      await forwarder.start(); // Redis is back
      await eventually(
        async () => ((await redis.queue.ping().catch(() => undefined)) === 'PONG' ? true : undefined),
        10_000,
      );
      await eventually(
        async () => ((await redis.cache.ping().catch(() => undefined)) === 'PONG' ? true : undefined),
        10_000,
      );
      expect(await redis.queue.set('gsm:test:restart-probe', '1', 'EX', 5)).toBe('OK');
    } finally {
      await forwarder.stop();
    }
  });
});
