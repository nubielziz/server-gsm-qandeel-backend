// Unit tests of the data request rules (feature 18): the deadline and the moves.
import { describe, expect, it } from 'bun:test';
import { dueDateOf, refuseMove } from './data-requests';

describe('dueDateOf', () => {
  it('is 30 days after the request', () => {
    expect(dueDateOf(new Date('2026-11-08T09:00:00.000Z')).toISOString()).toBe('2026-12-08T09:00:00.000Z');
  });
});

describe('refuseMove', () => {
  const move = (change: Partial<Parameters<typeof refuseMove>[0]>) =>
    refuseMove({
      kind: 'export',
      from: 'open',
      to: 'in_progress',
      note: undefined,
      customerAnonymized: false,
      ...change,
    });

  it('allows the documented moves', () => {
    expect(move({})).toBeUndefined();
    expect(move({ to: 'completed' })).toBeUndefined();
    expect(move({ from: 'in_progress', to: 'completed' })).toBeUndefined();
    expect(move({ to: 'rejected', note: 'Could not verify the requester' })).toBeUndefined();
  });

  it('refuses a closed request', () => {
    expect(move({ from: 'completed', to: 'rejected', note: 'x' })).toEqual({ code: 'REQUEST_CLOSED' });
    expect(move({ from: 'rejected' })).toEqual({ code: 'REQUEST_CLOSED' });
  });

  it('needs a non-blank note of at most 300 characters for a rejection', () => {
    expect(move({ to: 'rejected' })).toMatchObject({ code: 'VALIDATION_FAILED', field: 'note' });
    expect(move({ to: 'rejected', note: '   ' })).toMatchObject({ code: 'VALIDATION_FAILED', field: 'note' });
    expect(move({ to: 'rejected', note: 'x'.repeat(301) })).toMatchObject({ code: 'VALIDATION_FAILED', field: 'note' });
    expect(move({ to: 'rejected', note: 'x'.repeat(300) })).toBeUndefined();
  });

  it('keeps an erasure request open until the customer is anonymized', () => {
    expect(move({ kind: 'erasure', to: 'completed' })).toEqual({ code: 'ERASURE_NOT_DONE' });
    expect(move({ kind: 'erasure', to: 'completed', customerAnonymized: true })).toBeUndefined();
    expect(move({ kind: 'erasure', to: 'in_progress' })).toBeUndefined();
    expect(move({ kind: 'erasure', to: 'rejected', note: 'Legal hold' })).toBeUndefined();
  });

  it('does not move an in-progress request to in progress again', () => {
    expect(move({ from: 'in_progress', to: 'in_progress' })).toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'status',
    });
  });
});
