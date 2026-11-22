// Unit tests of the in-process fallback of the sign-in lock: what it does while the cache Redis is down (the Redis path runs in
// test/integration/identity/sign-in-lock.test.ts and test/integration/customers/store-sign-in.test.ts).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { MINUTE, TestClock } from '../../../../support/clock';
import { CacheKeys } from '@src/infra/cache';
import type { TokenService } from '@src/infra/crypto';
import type { RedisService } from '@src/infra/redis';
import { parseEnv } from '@src/config';
import { SignInFailures } from '@src/modules/identity/infra/sign-in-failures';

/** A cache Redis that fails every command, like a client whose connection is gone. */
const deadRedis = {
  cache: {
    hget: () => Promise.reject(new Error('connection is closed')),
    hset: () => Promise.reject(new Error('connection is closed')),
    del: () => Promise.reject(new Error('connection is closed')),
    eval: () => Promise.reject(new Error('connection is closed')),
    multi: () => {
      throw new Error('connection is closed');
    },
  },
} as unknown as RedisService;
const tokens = { hash: (text: string) => createHash('sha256').update(text).digest('hex') } as unknown as TokenService;

function setup() {
  const clock = new TestClock('2026-11-07T10:00:00.000Z');
  const failures = new SignInFailures(deadRedis, new CacheKeys(parseEnv({ NODE_ENV: 'test' })), tokens, clock);
  return { clock, failures };
}

/** Charges an email `times` times and answers the last charge. */
async function chargeTimes(failures: SignInFailures, email: string, times: number, scope: 'staff' | 'shop' = 'shop') {
  let last = await failures.charge(scope, email);
  for (let i = 1; i < times; i++) last = await failures.charge(scope, email);
  return last;
}

describe('SignInFailures while the cache Redis is down', () => {
  it('counts every attempt and reads the lock in the same step; the lock ends by the clock, and nothing throws', async () => {
    const { clock, failures } = setup();
    expect(await chargeTimes(failures, 'who@example.com', 11)).toEqual({ attempts: 11, lockedForSeconds: 0 });
    expect(await failures.startLock('shop', 'who@example.com')).toBe(15 * 60);
    // The lock started the count again; letters and spaces do not make another email; another email is not locked.
    expect(await failures.charge('shop', ' WHO@example.com ')).toEqual({ attempts: 1, lockedForSeconds: 15 * 60 });
    expect(await failures.charge('shop', 'other@example.com')).toEqual({ attempts: 1, lockedForSeconds: 0 });

    clock.advance(10 * MINUTE);
    expect((await failures.charge('shop', 'who@example.com')).lockedForSeconds).toBe(5 * 60);
    clock.advance(5 * MINUTE);
    expect((await failures.charge('shop', 'who@example.com')).lockedForSeconds).toBe(0);
  });

  it('counts the scopes apart: console attempts do not count on the shop', async () => {
    const { failures } = setup();
    await chargeTimes(failures, 'who@example.com', 11, 'staff');
    await failures.startLock('staff', 'who@example.com');
    expect(await failures.charge('staff', 'who@example.com')).toEqual({ attempts: 1, lockedForSeconds: 15 * 60 });
    expect(await failures.charge('shop', 'who@example.com')).toEqual({ attempts: 1, lockedForSeconds: 0 });
  });

  it('takes back one attempt only: a success between failures leaves the failures of the others counted', async () => {
    const { failures } = setup();
    await chargeTimes(failures, 'a@example.com', 9);
    // The tenth attempt had the right password and gives its own count back; the nine failures before it stay.
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(10);
    await failures.giveBack('shop', 'a@example.com');
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(10);
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(11);
  });

  it('never takes back below 0, and makes nothing for an email with nothing counted', async () => {
    const { failures } = setup();
    await failures.giveBack('shop', 'a@example.com');
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(1);
    for (let i = 0; i < 3; i++) await failures.giveBack('shop', 'a@example.com');
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(1);
  });

  it('forgets the count after a clear and after 16 minutes without an attempt', async () => {
    const { clock, failures } = setup();
    await chargeTimes(failures, 'a@example.com', 9);
    await failures.clear('shop', 'a@example.com');
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(1);

    await chargeTimes(failures, 'a@example.com', 8);
    clock.advance(16 * MINUTE);
    expect((await failures.charge('shop', 'a@example.com')).attempts).toBe(1);
  });

  it('ends a running lock with clear', async () => {
    const { failures } = setup();
    await chargeTimes(failures, 'a@example.com', 11);
    await failures.startLock('shop', 'a@example.com');
    await failures.clear('shop', 'a@example.com');
    expect(await failures.charge('shop', 'a@example.com')).toEqual({ attempts: 1, lockedForSeconds: 0 });
  });

  it('gives an email its whole budget again once the lock it started has ended', async () => {
    const { clock, failures } = setup();
    await chargeTimes(failures, 'a@example.com', 11);
    await failures.startLock('shop', 'a@example.com');
    clock.advance(15 * MINUTE + 1000);
    expect(await chargeTimes(failures, 'a@example.com', 10)).toEqual({ attempts: 10, lockedForSeconds: 0 });
  });
});
