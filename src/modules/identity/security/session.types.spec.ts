// Unit tests of the session expiry rule (decision 018) and of the stage list shared with the database.
import { describe, expect, it } from 'bun:test';
import { SESSION_STAGES } from '../../../common/contract';
import { SESSION_STAGES as TABLE_STAGES } from '../db/schema';
import { livenessOf } from './session.types';

const MINUTE = 60_000;
const view = (over: Partial<Parameters<typeof livenessOf>[0]> = {}) => ({
  expiresAtMs: 1_000 * MINUTE,
  lastSeenAtMs: 100 * MINUTE,
  idleMs: 30 * MINUTE,
  ...over,
});

describe('livenessOf', () => {
  it('is live before the absolute end and within the idle limit', () => {
    expect(livenessOf(view(), 100 * MINUTE)).toBe('live');
    expect(livenessOf(view(), 130 * MINUTE)).toBe('live');
  });

  it('is idle after more than the idle limit without use', () => {
    expect(livenessOf(view(), 130 * MINUTE + 1)).toBe('idle');
    expect(livenessOf(view(), 500 * MINUTE)).toBe('idle');
  });

  it('is expired from the absolute end on, whatever the idle state', () => {
    expect(livenessOf(view({ lastSeenAtMs: 999 * MINUTE }), 1_000 * MINUTE)).toBe('expired');
    expect(livenessOf(view({ lastSeenAtMs: 999 * MINUTE }), 999 * MINUTE + 59_999)).toBe('live');
    expect(livenessOf(view(), 2_000 * MINUTE)).toBe('expired');
  });

  it('has no idle limit when idleMs is 0 (a pending step lives for its short absolute time only)', () => {
    expect(livenessOf(view({ idleMs: 0 }), 900 * MINUTE)).toBe('live');
    expect(livenessOf(view({ idleMs: 0 }), 1_000 * MINUTE)).toBe('expired');
  });
});

describe('session stages', () => {
  it('are the same in the contract layer and in the sessions table', () => {
    expect([...SESSION_STAGES]).toEqual([...TABLE_STAGES]);
  });
});
