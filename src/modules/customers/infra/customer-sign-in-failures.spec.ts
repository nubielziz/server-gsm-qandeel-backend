// Unit tests of the in-process fallback of the customer sign-in lock: what it does while the cache Redis is down (the Redis path
// runs in test/integration/store-sign-in.test.ts).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { MINUTE, TestClock } from '../../../../test/support/clock';
import { CacheKeys } from '../../../infra/cache';
import type { TokenService } from '../../../infra/crypto';
import type { RedisService } from '../../../infra/redis';
import { parseEnv } from '../../../config';
import { CustomerSignInFailures } from './customer-sign-in-failures';

/** A cache Redis that fails every command, like a client whose connection is gone. */
const deadRedis = {
  cache: {
    hget: () => Promise.reject(new Error('connection is closed')),
    del: () => Promise.reject(new Error('connection is closed')),
    multi: () => {
      throw new Error('connection is closed');
    },
  },
} as unknown as RedisService;
const tokens = { hash: (text: string) => createHash('sha256').update(text).digest('hex') } as unknown as TokenService;

function setup() {
  const clock = new TestClock('2026-11-07T10:00:00.000Z');
  const failures = new CustomerSignInFailures(deadRedis, new CacheKeys(parseEnv({ NODE_ENV: 'test' })), tokens, clock);
  return { clock, failures };
}

describe('CustomerSignInFailures while the cache Redis is down', () => {
  it('locks an email on the tenth failure for 15 minutes, by the clock, and never throws', async () => {
    const { clock, failures } = setup();
    for (let i = 0; i < 9; i++) await failures.recordFailure('who@example.com');
    expect(await failures.lockedFor('who@example.com')).toBe(0);
    await failures.recordFailure('who@example.com');
    expect(await failures.lockedFor('who@example.com')).toBe(15 * 60);
    // Letters and spaces do not make another email; another email is not locked.
    expect(await failures.lockedFor(' WHO@example.com ')).toBe(15 * 60);
    expect(await failures.lockedFor('other@example.com')).toBe(0);

    clock.advance(10 * MINUTE);
    expect(await failures.lockedFor('who@example.com')).toBe(5 * 60);
    clock.advance(5 * MINUTE);
    expect(await failures.lockedFor('who@example.com')).toBe(0);
  });

  it('forgets the failures after a clear and after 16 minutes without a failure', async () => {
    const { clock, failures } = setup();
    for (let i = 0; i < 9; i++) await failures.recordFailure('a@example.com');
    await failures.clear('a@example.com');
    for (let i = 0; i < 9; i++) await failures.recordFailure('a@example.com');
    expect(await failures.lockedFor('a@example.com')).toBe(0);

    clock.advance(16 * MINUTE);
    for (let i = 0; i < 9; i++) await failures.recordFailure('a@example.com');
    expect(await failures.lockedFor('a@example.com')).toBe(0);
  });
});
