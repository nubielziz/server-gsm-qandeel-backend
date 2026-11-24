// Unit tests of the suspension reasons the retired customer route still names (decision 064: the status rules of sign-in are identity's).
import { describe, expect, it } from 'bun:test';
import { MAX_SUSPEND_NOTE_LENGTH, SUSPEND_REASONS } from '@src/modules/customers/domain/customer-status';

describe('the suspension reasons', () => {
  it('are exactly the five reasons of the console, with a note of at most 200 characters', () => {
    expect(SUSPEND_REASONS).toHaveLength(5);
    expect(SUSPEND_REASONS).toContain('Waiting for proof of identity or payment');
    expect(SUSPEND_REASONS.at(-1)).toBe('Other');
    expect(MAX_SUSPEND_NOTE_LENGTH).toBe(200);
  });
});
