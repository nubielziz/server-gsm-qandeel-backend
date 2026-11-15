// Unit tests of the doorbell publisher (decision 037) with a fake Redis: the channel name, the 8 KB limit, failures never thrown.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { MetricsService } from '../metrics/metrics.service';
import type { RedisService } from '../redis';
import { MAX_DOORBELL_BYTES, RealtimePublisher, realtimeChannel, redisDatabaseOf } from './realtime-publisher';
import { expectRejection } from '../../../test/support/rejection';
import { TestClock } from '../../../test/support/clock';

function publisher(env: AppConfig['env'], publish: (channel: string, message: string) => Promise<number>) {
  const config = { env, redis: { cacheUrl: 'redis://cache:6380/7' } } as unknown as AppConfig;
  const metrics = new MetricsService();
  const redis = { cache: { publish } } as unknown as RedisService;
  const clock = new TestClock('2026-11-15T10:00:00.000Z');
  return { publisher: new RealtimePublisher(config, redis, clock, metrics), metrics };
}

beforeEach(() => {
  spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  (Logger.prototype.warn as unknown as { mockRestore: () => void }).mockRestore();
  (Logger.prototype.error as unknown as { mockRestore: () => void }).mockRestore();
});

describe('realtimeChannel', () => {
  it('names the environment and the database number of the cache URL (pub/sub ignores SELECT)', () => {
    expect(redisDatabaseOf('redis://localhost:6380/7')).toBe(7);
    expect(redisDatabaseOf('rediss://user:pw@cache.internal:6380')).toBe(0);
    expect(redisDatabaseOf('redis://localhost:6380/')).toBe(0);
    expect(realtimeChannel({ env: 'production', redis: { cacheUrl: 'redis://c:1/3' } } as AppConfig)).toBe(
      'gsm:production:realtime:doorbell:3',
    );
  });
});

describe('RealtimePublisher', () => {
  it('publishes the doorbell with v, topic, op and the clock time on the channel, and counts it', async () => {
    const sent: Array<[string, string]> = [];
    const { publisher: p, metrics } = publisher('test', (channel, message) => {
      sent.push([channel, message]);
      return Promise.resolve(1);
    });
    expect(await p.publish('inbox', 'created', { type: 'customer', ids: [42], itemId: 9001 })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe('gsm:test:realtime:doorbell:7');
    expect(JSON.parse(sent[0]![1])).toEqual({
      v: 1,
      topic: 'inbox',
      op: 'created',
      at: Date.parse('2026-11-15T10:00:00.000Z'),
      type: 'customer',
      ids: [42],
      itemId: 9001,
    });
    expect(await metrics.render()).toContain('realtime_doorbells_published_total{topic="inbox"} 1');
  });

  it('never throws a Redis failure to the use case: it is counted', async () => {
    const { publisher: p, metrics } = publisher('production', () => Promise.reject(new Error('Connection is closed.')));
    expect(await p.publish('session', 'ended', { sessionIds: [1] })).toBe(false);
    expect(await metrics.render()).toContain('realtime_publish_failures_total{topic="session"} 1');
  });

  it('refuses a doorbell over 8 KB: a thrown programming error under test, a counted failure elsewhere', async () => {
    const huge = { ids: Array.from({ length: MAX_DOORBELL_BYTES }, (_, n) => n) };
    const strict = publisher('test', () => Promise.resolve(1));
    await expectRejection(strict.publisher.publish('inbox', 'created', huge), Error);
    let sent = 0;
    const lenient = publisher('production', () => Promise.resolve(++sent));
    expect(await lenient.publisher.publish('inbox', 'created', huge)).toBe(false);
    expect(sent).toBe(0);
    expect(await lenient.metrics.render()).toContain('realtime_publish_failures_total{topic="inbox"} 1');
  });
});
