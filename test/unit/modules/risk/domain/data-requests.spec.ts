// Unit tests of the data request rules (feature 18, decision 064): the deadline, the moves and who may ask for an erasure.
import { describe, expect, it } from 'bun:test';
import {
  MERCHANT_ERASURE_MESSAGE,
  dueDateOf,
  refuseMove,
  refuseOwnRequest,
} from '@src/modules/risk/domain/data-requests';

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
      accountAnonymized: false,
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

  it('keeps an erasure request open until the account is anonymized', () => {
    expect(move({ kind: 'erasure', to: 'completed' })).toEqual({ code: 'ERASURE_NOT_DONE' });
    expect(move({ kind: 'erasure', to: 'completed', accountAnonymized: true })).toBeUndefined();
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

describe('refuseOwnRequest', () => {
  it('lets every rank ask for a copy of its data', () => {
    expect(refuseOwnRequest('export', 'retail')).toBeUndefined();
    expect(refuseOwnRequest('export', 'merchant')).toBeUndefined();
  });

  it('lets the retail rank ask for erasure', () => {
    expect(refuseOwnRequest('erasure', 'retail')).toBeUndefined();
  });

  it('tells a merchant rank to ask for the move to the retail rank first, in the words of decision 064', () => {
    expect(refuseOwnRequest('erasure', 'merchant')).toBe(MERCHANT_ERASURE_MESSAGE);
    expect(MERCHANT_ERASURE_MESSAGE).toBe(
      'This account has a merchant rank. Ask us to move it to the retail rank first; then you can ask for erasure.',
    );
  });
});
