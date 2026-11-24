// Unit tests of the rank kind a ticket's requester shows (decision 064): the one retail rank is retail, any other rank is a merchant rank, and
// a requester that is gone fails closed to retail. Pure; no database.
import { describe, expect, it } from 'bun:test';
import { rankKindOfRequester } from '@src/modules/support/domain/requester-rank';

describe('rankKindOfRequester', () => {
  const RETAIL = 3;

  it('says retail for the retail rank and merchant for every other rank', () => {
    expect(rankKindOfRequester(RETAIL, RETAIL)).toBe('retail');
    expect(rankKindOfRequester(1, RETAIL)).toBe('merchant');
    expect(rankKindOfRequester(2, RETAIL)).toBe('merchant');
    expect(rankKindOfRequester(4, RETAIL)).toBe('merchant');
  });

  it('fails closed: a requester that is gone (no row, no rank) is retail, never a merchant', () => {
    expect(rankKindOfRequester(null, RETAIL)).toBe('retail');
  });
});
