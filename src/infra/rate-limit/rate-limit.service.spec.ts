// Unit tests of the parts of the rate limiter that need no Redis: the limiter table, the composite key and the
// RATE_LIMITED error. The counting itself is in test/integration/rate-limit.test.ts.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../../common/errors';
import { RATE_LIMITERS } from './limiters';
import { RateLimitService, rateLimitedError } from './rate-limit.service';

describe('RATE_LIMITERS', () => {
  it('gives every limiter a positive budget and window, and describes it', () => {
    for (const [name, config] of Object.entries<{ points: number; windowSeconds: number; description: string }>(
      RATE_LIMITERS,
    )) {
      expect(Number.isInteger(config.points) && config.points > 0, name).toBe(true);
      expect(Number.isInteger(config.windowSeconds) && config.windowSeconds > 0, name).toBe(true);
      expect(config.description.length, name).toBeGreaterThan(20);
    }
  });

  it('has the limiters decision 021 names: per IP, per API key, sign-in, token lookups, per supplier', () => {
    expect(Object.keys(RATE_LIMITERS).sort()).toEqual([
      'api-key',
      'ip',
      'sign-in',
      'supplier',
      'token',
      'webhook-retry',
    ]);
  });

  it('locks a sign-in pair out for as long as its window after five attempts', () => {
    expect(RATE_LIMITERS['sign-in']).toMatchObject({ points: 5, windowSeconds: 900, blockSeconds: 900 });
  });

  it('uses limiter names that are valid parts of a Redis key', () => {
    for (const name of Object.keys(RATE_LIMITERS)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('RateLimitService.compositeKey', () => {
  it('is a stable 32-character hex hash that does not contain its parts', () => {
    const key = RateLimitService.compositeKey('Rami@Example.com', '203.0.113.9');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(RateLimitService.compositeKey('Rami@Example.com', '203.0.113.9'));
    expect(key).not.toContain('rami');
  });

  it('ignores case and surrounding spaces, and tells different parts and different splits apart', () => {
    const key = RateLimitService.compositeKey('rami@example.com', '203.0.113.9');
    expect(RateLimitService.compositeKey(' RAMI@EXAMPLE.COM ', '203.0.113.9 ')).toBe(key);
    expect(RateLimitService.compositeKey('rami@example.com', '203.0.113.10')).not.toBe(key);
    expect(RateLimitService.compositeKey('ab', 'c')).not.toBe(RateLimitService.compositeKey('a', 'bc'));
  });
});

describe('rateLimitedError', () => {
  it('is 429 RATE_LIMITED with a whole number of seconds of at least one', () => {
    const error = rateLimitedError(0.4);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(1);
    expect(rateLimitedError(59.01).retryAfterSeconds).toBe(60);
    expect(rateLimitedError(-5).retryAfterSeconds).toBe(1);
  });

  it('says how long to wait, in plain English', () => {
    expect(rateLimitedError(1).detail).toBe('Too many requests. Try again in 1 second.');
    expect(rateLimitedError(90).detail).toBe('Too many requests. Try again in 90 seconds.');
  });
});
