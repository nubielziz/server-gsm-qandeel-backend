// Unit tests of the Redis client factories and the health indicators with fake clients (decision 006): nothing here opens a
// connection. The behaviour against a real and a dead Redis is in test/integration/redis.test.ts.
import { describe, expect, it } from 'bun:test';
import type { Redis } from 'ioredis';
import {
  createCacheClient,
  createQueueProducerClient,
  createWorkerConnection,
  reconnectDelayMs,
} from './redis-clients';
import {
  QUEUE_MEMORY_ALERT_RATIO,
  RedisHealthIndicator,
  RedisQueueHealthIndicator,
  parseRedisMemory,
} from './redis.health';
import { expectRejection } from '../../../test/support/rejection';

const URL = 'redis://127.0.0.1:1/1';

describe('client factories', () => {
  it('build clients that have not connected: constructors never connect', () => {
    for (const client of [createCacheClient(URL), createQueueProducerClient(URL), createWorkerConnection(URL)]) {
      expect(client.status).toBe('wait');
      client.disconnect();
    }
  });

  it('give the cache and the queue producer no offline queue and a command timeout, so they fail at once', () => {
    for (const client of [createCacheClient(URL), createQueueProducerClient(URL)]) {
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.options.lazyConnect).toBe(true);
      expect(client.options.commandTimeout).toBeGreaterThan(0);
      expect(client.options.maxRetriesPerRequest).toBe(1);
      client.disconnect();
    }
  });

  it('give a worker connection maxRetriesPerRequest null (BullMQ requires it), an offline queue and no command timeout', () => {
    const client = createWorkerConnection(URL);
    expect(client.options.maxRetriesPerRequest).toBeNull();
    expect(client.options.enableOfflineQueue).not.toBe(false);
    expect(client.options.commandTimeout).toBeUndefined();
    client.disconnect();
  });

  it('name each connection, so CLIENT LIST tells them apart', () => {
    const names = [createCacheClient(URL), createQueueProducerClient(URL), createWorkerConnection(URL)].map(
      (client) => {
        const name = client.options.connectionName;
        client.disconnect();
        return name;
      },
    );
    expect(names).toEqual(['gsm-cache', 'gsm-queue-producer', 'gsm-queue-worker']);
  });

  it('take the database from the URL', () => {
    const client = createCacheClient('redis://localhost:6380/1');
    expect(client.options.db).toBe(1);
    expect(client.options.port).toBe(6380);
    client.disconnect();
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from about 200 ms and stops at about 5 s, with +-20 % jitter', () => {
    const bounds = (attempt: number, base: number) => {
      for (let i = 0; i < 200; i++) {
        const delay = reconnectDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      }
    };
    bounds(1, 200);
    bounds(2, 400);
    bounds(3, 800);
    bounds(5, 3200);
    bounds(6, 5000);
    bounds(50, 5000);
  });
});

describe('parseRedisMemory', () => {
  const info =
    '# Memory\r\nused_memory:2715152\r\nused_memory_human:2.59M\r\nmaxmemory:268435456\r\nmaxmemory_human:256.00M\r\n';

  it('reads used_memory and maxmemory from INFO memory', () => {
    expect(parseRedisMemory(info)).toEqual({ usedBytes: 2_715_152, maxBytes: 268_435_456 });
  });

  it('does not mistake used_memory_human or maxmemory_policy for the numbers', () => {
    expect(parseRedisMemory('used_memory_human:1G\nused_memory:5\nmaxmemory_policy:noeviction\nmaxmemory:0\n')).toEqual(
      {
        usedBytes: 5,
        maxBytes: 0,
      },
    );
  });

  it('treats a missing maxmemory as unlimited and a missing used_memory as an error', () => {
    expect(parseRedisMemory('used_memory:10\r\n').maxBytes).toBe(0);
    expect(() => parseRedisMemory('# Memory\r\nmaxmemory:10\r\n')).toThrow(/used_memory/);
    expect(() => parseRedisMemory('')).toThrow(/used_memory/);
  });
});

/** A fake client that answers the two commands the indicators use. */
function fake(answers: { ping?: string | Error; info?: string | Error }): Redis {
  const answer = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    ping: () => answer(answers.ping ?? 'PONG'),
    info: () => answer(answers.info ?? 'used_memory:10\r\nmaxmemory:0\r\n'),
  } as unknown as Redis;
}

describe('RedisHealthIndicator', () => {
  it('is the non-critical "redis" check', () => {
    const indicator = new RedisHealthIndicator(fake({}));
    expect(indicator.name).toBe('redis');
    expect(indicator.critical).toBe(false);
  });

  it('passes on PONG and fails on an error or another reply', async () => {
    expect(await new RedisHealthIndicator(fake({})).check()).toBeUndefined();
    await expectRejection(new RedisHealthIndicator(fake({ ping: new Error('down') })).check(), 'down');
    await expectRejection(new RedisHealthIndicator(fake({ ping: 'LOADING' })).check(), /unexpected/);
  });
});

describe('RedisQueueHealthIndicator', () => {
  it('is the non-critical "redis_queue" check', () => {
    const indicator = new RedisQueueHealthIndicator(fake({}));
    expect(indicator.name).toBe('redis_queue');
    expect(indicator.critical).toBe(false);
  });

  it('passes when memory is below the alert ratio, or when maxmemory is 0 (no limit)', async () => {
    expect(
      await new RedisQueueHealthIndicator(fake({ info: 'used_memory:100\r\nmaxmemory:1000\r\n' })).check(),
    ).toBeUndefined();
    expect(
      await new RedisQueueHealthIndicator(fake({ info: 'used_memory:999999999\r\nmaxmemory:0\r\n' })).check(),
    ).toBeUndefined();
  });

  it('fails at 90 % of maxmemory and above, naming the percentage and the reason', async () => {
    expect(QUEUE_MEMORY_ALERT_RATIO).toBe(0.9);
    expect(
      await new RedisQueueHealthIndicator(fake({ info: 'used_memory:899\r\nmaxmemory:1000\r\n' })).check(),
    ).toBeUndefined();
    await expectRejection(
      new RedisQueueHealthIndicator(fake({ info: 'used_memory:900\r\nmaxmemory:1000\r\n' })).check(),
      /90 % of maxmemory.*refuses writes/,
    );
    await expectRejection(
      new RedisQueueHealthIndicator(fake({ info: 'used_memory:2000\r\nmaxmemory:1000\r\n' })).check(),
      /200 %/,
    );
  });

  it('fails when Redis cannot be reached', async () => {
    await expectRejection(new RedisQueueHealthIndicator(fake({ info: new Error("Stream isn't writeable") })).check());
  });
});
