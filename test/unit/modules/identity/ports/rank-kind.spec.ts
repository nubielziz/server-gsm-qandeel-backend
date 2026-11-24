// Unit tests of the rank kind: which rights the stored kind of a rank gives (decision 064).
import { describe, expect, it } from 'bun:test';
import { rankKindOf } from '@src/modules/identity/ports/rank-kind';

describe('rankKindOf', () => {
  it('gives merchant rights to the b2b kind', () => {
    expect(rankKindOf('b2b')).toBe('merchant');
  });

  it('gives retail rights to the retail kind', () => {
    expect(rankKindOf('b2c_retail')).toBe('retail');
  });

  it('fails closed: every other value is retail, never merchant', () => {
    for (const unknown of ['', 'B2B', ' b2b', 'b2b ', 'merchant', 'retail', 'vip', 'b2b_plus', 'null']) {
      expect(rankKindOf(unknown)).toBe('retail');
    }
  });
});
