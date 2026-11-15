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
      'account-mail',
      'api-key',
      'broadcast-email',
      'broadcast-telegram',
      'help-vote',
      'ip',
      'media',
      'sign-in',
      'stream-connect',
      'supplier',
      'ticket-chat',
      'ticket-email',
      'ticket-message',
      'ticket-open',
      'token',
      'upload',
      'wallet-topup',
      'webhook-retry',
    ]);
  });

  it('locks a sign-in pair out for as long as its window after five attempts', () => {
    expect(RATE_LIMITERS['sign-in']).toMatchObject({ points: 5, windowSeconds: 900, blockSeconds: 900 });
  });

  it('lets one session open 20 live streams a minute (decision 037)', () => {
    expect(RATE_LIMITERS['stream-connect']).toMatchObject({ points: 20, windowSeconds: 60 });
  });

  it('gives a ticket page 120 typing and read calls a minute, a ticket 20 requester messages and an account 5 tickets an hour (feature 28)', () => {
    expect(RATE_LIMITERS['ticket-chat']).toMatchObject({ points: 120, windowSeconds: 60 });
    expect(RATE_LIMITERS['ticket-message']).toMatchObject({ points: 20, windowSeconds: 60 });
    expect(RATE_LIMITERS['ticket-open']).toMatchObject({ points: 5, windowSeconds: 3600 });
  });

  it('lets one email address open 3 tickets an hour on the public form', () => {
    expect(RATE_LIMITERS['ticket-email']).toMatchObject({ points: 3, windowSeconds: 3600 });
  });

  it('sends at most 5 campaign emails and 20 campaign Telegram messages a second by default (feature 23)', () => {
    expect(RATE_LIMITERS['broadcast-email']).toMatchObject({ points: 5, windowSeconds: 1 });
    expect(RATE_LIMITERS['broadcast-telegram']).toMatchObject({ points: 20, windowSeconds: 1 });
  });

  it('lets one account have 5 emails of a kind an hour, with no lock-out', () => {
    expect(RATE_LIMITERS['account-mail']).toMatchObject({ points: 5, windowSeconds: 3600 });
    expect(RATE_LIMITERS['account-mail']).not.toHaveProperty('blockSeconds');
  });

  it('counts one help vote per visitor address and article per day', () => {
    expect(RATE_LIMITERS['help-vote']).toMatchObject({ points: 1, windowSeconds: 86_400 });
  });

  it('gives the public pictures their own budget of 1200 a minute per address, apart from the 300 of the API', () => {
    expect(RATE_LIMITERS.media).toMatchObject({ points: 1200, windowSeconds: 60 });
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
