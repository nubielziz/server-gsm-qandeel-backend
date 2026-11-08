// Unit tests of the temporary lock after repeated failed sign-ins.
import { describe, expect, it } from 'bun:test';
import { LOCK_DURATION_MS, MAX_FAILED_ATTEMPTS, lockedForSeconds, locksAfter } from './lockout';

const NOW = Date.parse('2026-11-07T10:00:00.000Z');

describe('locksAfter', () => {
  it('locks on the tenth failure in a row, not before', () => {
    expect(locksAfter(MAX_FAILED_ATTEMPTS - 1)).toBe(false);
    expect(locksAfter(MAX_FAILED_ATTEMPTS)).toBe(true);
    expect(locksAfter(MAX_FAILED_ATTEMPTS + 3)).toBe(true);
    expect(MAX_FAILED_ATTEMPTS).toBe(10);
  });
});

describe('lockedForSeconds', () => {
  it('is 0 for an email that was never locked or whose lock ended, and rounds the time left up', () => {
    expect(lockedForSeconds(0, NOW)).toBe(0);
    expect(lockedForSeconds(NOW, NOW)).toBe(0);
    expect(lockedForSeconds(NOW - 1, NOW)).toBe(0);
    expect(lockedForSeconds(NOW + 1500, NOW)).toBe(2);
    expect(lockedForSeconds(NOW + LOCK_DURATION_MS, NOW)).toBe(900);
  });
});
