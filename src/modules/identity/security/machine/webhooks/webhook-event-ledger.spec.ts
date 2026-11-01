// Unit tests of the replay filter with a fake cache Redis: the key never holds the raw event id, the mark is set once with a
// time to live, a Redis failure is not an error for the delivery, and a mark can be forgotten.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '../../../../../config';
import { CacheKeys } from '../../../../../infra/cache';
import type { RedisService } from '../../../../../infra/redis';
import { WEBHOOK_EVENT_TTL_MS, WebhookEventLedger } from './webhook-event-ledger';

const keys = new CacheKeys(parseEnv({ NODE_ENV: 'test' }));

function fakeRedis(options: { fails?: boolean } = {}) {
  const marks = new Map<string, { ttl: number }>();
  const unlinked: string[] = [];
  const cache = {
    set: (key: string, _value: string, _px: 'PX', ttl: number, _nx: 'NX') => {
      if (options.fails) return Promise.reject(new Error('connection refused'));
      if (marks.has(key)) return Promise.resolve(null);
      marks.set(key, { ttl });
      return Promise.resolve('OK');
    },
    unlink: (key: string) => {
      if (options.fails) return Promise.reject(new Error('connection refused'));
      unlinked.push(key);
      marks.delete(key);
      return Promise.resolve(1);
    },
  };
  return { redis: { cache } as unknown as RedisService, marks, unlinked };
}

describe('WebhookEventLedger', () => {
  it('says new for the first delivery and duplicate for a repeat, per gateway', async () => {
    const { redis } = fakeRedis();
    const ledger = new WebhookEventLedger(redis, keys);
    expect(await ledger.claim('stripe', 'evt_1')).toBe('new');
    expect(await ledger.claim('stripe', 'evt_1')).toBe('duplicate');
    expect(await ledger.claim('stripe', 'evt_2')).toBe('new');
    expect(await ledger.claim('wise', 'evt_1')).toBe('new');
  });

  it('keeps the mark for 15 minutes under a key built from the hash of the event id, never the id itself', async () => {
    const { redis, marks } = fakeRedis();
    await new WebhookEventLedger(redis, keys).claim('stripe', 'evt_with:odd chars/and*glob');
    const [key] = [...marks.keys()];
    expect(key).toBe(
      `gsm:test:identity:webhook-event:stripe:${createHash('sha256').update('evt_with:odd chars/and*glob').digest('hex')}`,
    );
    expect(marks.get(key!)?.ttl).toBe(WEBHOOK_EVENT_TTL_MS);
    expect(WEBHOOK_EVENT_TTL_MS).toBe(15 * 60 * 1000);
    expect(key).not.toContain('evt_with');
  });

  it('says unavailable, and does not throw, when the cache Redis fails', async () => {
    const { redis } = fakeRedis({ fails: true });
    const ledger = new WebhookEventLedger(redis, keys);
    expect(await ledger.claim('stripe', 'evt_1')).toBe('unavailable');
    expect(await ledger.release('stripe', 'evt_1')).toBeUndefined();
  });

  it('forgets an event so the next delivery is new again', async () => {
    const { redis, unlinked } = fakeRedis();
    const ledger = new WebhookEventLedger(redis, keys);
    expect(await ledger.claim('stripe', 'evt_1')).toBe('new');
    await ledger.release('stripe', 'evt_1');
    expect(unlinked).toHaveLength(1);
    expect(await ledger.claim('stripe', 'evt_1')).toBe('new');
  });
});
