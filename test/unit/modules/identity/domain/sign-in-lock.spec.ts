// Unit tests of the temporary lock after repeated failed sign-ins and of the network rule of decision 052.
import { describe, expect, it } from 'bun:test';
import {
  FAMILIAR_SIGN_INS_READ,
  MAX_FAILED_SIGN_INS,
  SIGN_IN_LOCK_MS,
  exceedsFailureBudget,
  isFamiliarNetwork,
  lockedForSeconds,
} from '@src/modules/identity/domain/sign-in-lock';

const NOW = Date.parse('2026-11-07T10:00:00.000Z');

describe('exceedsFailureBudget', () => {
  it('lets ten counted attempts be checked and refuses from the eleventh on', () => {
    expect(exceedsFailureBudget(1)).toBe(false);
    expect(exceedsFailureBudget(MAX_FAILED_SIGN_INS)).toBe(false);
    expect(exceedsFailureBudget(MAX_FAILED_SIGN_INS + 1)).toBe(true);
    expect(exceedsFailureBudget(MAX_FAILED_SIGN_INS + 30)).toBe(true);
    expect(MAX_FAILED_SIGN_INS).toBe(10);
    expect(FAMILIAR_SIGN_INS_READ).toBe(50);
  });
});

describe('lockedForSeconds', () => {
  it('is 0 for an email that was never locked or whose lock ended, and rounds the time left up', () => {
    expect(lockedForSeconds(0, NOW)).toBe(0);
    expect(lockedForSeconds(NOW, NOW)).toBe(0);
    expect(lockedForSeconds(NOW - 1, NOW)).toBe(0);
    expect(lockedForSeconds(NOW + 1500, NOW)).toBe(2);
    expect(lockedForSeconds(NOW + SIGN_IN_LOCK_MS, NOW)).toBe(900);
  });
});

describe('isFamiliarNetwork', () => {
  it('treats the same IPv4 /24 as familiar and the next /24 as strange', () => {
    expect(isFamiliarNetwork('198.51.100.200', ['198.51.100.7'])).toBe(true);
    expect(isFamiliarNetwork('198.51.101.7', ['198.51.100.7'])).toBe(false);
  });

  it('treats the same IPv6 /64 (any interface id) as familiar and another /64 as strange', () => {
    expect(isFamiliarNetwork('2001:db8:1:2::99', ['2001:db8:1:2::1'])).toBe(true);
    expect(isFamiliarNetwork('2001:db8:1:2:ffff:ffff:ffff:ffff', ['2001:db8:1:2::1'])).toBe(true);
    expect(isFamiliarNetwork('2001:db8:1:3::1', ['2001:db8:1:2::1'])).toBe(false);
  });

  it('never matches an IPv4 address against an IPv6 one', () => {
    expect(isFamiliarNetwork('198.51.100.7', ['2001:db8:1:2::1'])).toBe(false);
    expect(isFamiliarNetwork('2001:db8:1:2::1', ['198.51.100.7'])).toBe(false);
  });

  it('is false for an empty list, an unparseable stored address and an unparseable request address', () => {
    expect(isFamiliarNetwork('198.51.100.7', [])).toBe(false);
    expect(isFamiliarNetwork('198.51.100.7', ['not an address', ''])).toBe(false);
    expect(isFamiliarNetwork('unknown', ['198.51.100.7'])).toBe(false);
  });

  it('matches an IPv4-mapped stored address against a plain IPv4 request', () => {
    expect(isFamiliarNetwork('203.0.113.50', ['::ffff:203.0.113.9'])).toBe(true);
    expect(isFamiliarNetwork('::ffff:203.0.113.50', ['203.0.113.9'])).toBe(true);
  });

  it('finds the network anywhere in the list', () => {
    expect(isFamiliarNetwork('198.51.100.7', ['203.0.113.1', '2001:db8::1', '198.51.100.99'])).toBe(true);
  });
});
