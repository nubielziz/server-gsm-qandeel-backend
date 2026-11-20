// SupplierThrottle (decisions 021 and 044): a supplier's own limits answer `unavailable` instead of throwing when the cache Redis does not
// answer, so the dispatch job and the poll treat it as busy; with Redis up the limits behave as before.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RateLimitService } from '@src/infra/rate-limit';
import { SupplierThrottle } from '@src/modules/suppliers/application/supplier-client';
import { type InfraHarness, createInfra, deadRedisUrl } from '../../support/infra';

let up: InfraHarness;

beforeAll(async () => {
  up = await createInfra();
});
afterAll(async () => {
  await up.close();
});

const supplier = (id: number, over: { maxConcurrency?: number; rateLimitPerMin?: number } = {}) => ({
  id,
  maxConcurrency: over.maxConcurrency ?? 2,
  rateLimitPerMin: over.rateLimitPerMin ?? 60,
  timeoutMs: 1_000,
});

describe('SupplierThrottle.admit', () => {
  it('answers unavailable instead of throwing when the cache Redis does not answer', async () => {
    const down = await createInfra({ env: { REDIS_CACHE_URL_TEST: await deadRedisUrl() } });
    try {
      const throttle = new SupplierThrottle(down.get(RateLimitService));
      expect(await throttle.admit(supplier(7_001))).toEqual({ ok: false, reason: 'unavailable', retryAfterSeconds: 2 });
      // The failure is logged once per supplier per interval, not on every call, and never with a credential.
      expect(await throttle.admit(supplier(7_001))).toMatchObject({ ok: false, reason: 'unavailable' });
      const warnings = down.logger.lines.filter((line) =>
        line.includes('call limits of supplier 7001 could not be checked'),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      await down.close();
    }
  });

  it('still admits, refuses a full semaphore and gives the place back while Redis answers', async () => {
    const throttle = new SupplierThrottle(up.get(RateLimitService));
    const id = 7_100 + Math.floor(Math.random() * 800);
    const first = await throttle.admit(supplier(id, { maxConcurrency: 1 }));
    expect(first.ok).toBe(true);
    expect(await throttle.admit(supplier(id, { maxConcurrency: 1 }))).toMatchObject({ ok: false, reason: 'busy' });
    if (first.ok) await throttle.release(first.lease);
    const again = await throttle.admit(supplier(id, { maxConcurrency: 1 }));
    expect(again.ok).toBe(true);
    if (again.ok) await throttle.release(again.lease);
  });
});
