import { describe, expect, it } from 'bun:test';
import {
  cleanHiddenTerm,
  cleanPin,
  cleanSynonym,
  ruleApplies,
} from '@src/modules/storefront/search/domain/settings-rules';

describe('cleanSynonym', () => {
  it('normalises the terms like a query and keeps their order', () => {
    const result = cleanSynonym({ kind: 'multi', terms: ['  AT&T ', 'Google  Account Lock'] });
    expect(result).toEqual({ ok: true, value: { kind: 'multi', root: null, terms: ['att', 'google account lock'] } });
  });

  it('refuses empty, repeated and long terms, and a list outside 2-20', () => {
    const bad = cleanSynonym({ kind: 'multi', terms: ['a', 'A', '', 'x'.repeat(61)] });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.problems.map((p) => [p.field, p.code])).toEqual([
        ['terms.1', 'duplicate'],
        ['terms.2', 'empty'],
        ['terms.3', 'too_long'],
      ]);
    const few = cleanSynonym({ kind: 'multi', terms: ['one'] });
    expect(few.ok ? null : few.problems[0]?.field).toBe('terms');
    expect(cleanSynonym({ kind: 'multi', terms: Array.from({ length: 21 }, (_, i) => `t${i}`) }).ok).toBe(false);
    expect(cleanSynonym({ kind: 'multi', terms: Array.from({ length: 20 }, (_, i) => `t${i}`) }).ok).toBe(true);
  });

  it('needs a root for a one-way synonym and ignores it for a multi-way one', () => {
    const missing = cleanSynonym({ kind: 'one_way', terms: ['a b', 'c d'] });
    expect(missing.ok ? null : missing.problems[0]?.field).toBe('root');
    expect(cleanSynonym({ kind: 'one_way', root: 'Sim', terms: ['sim unlock', 'sim lock'] })).toEqual({
      ok: true,
      value: { kind: 'one_way', root: 'sim', terms: ['sim unlock', 'sim lock'] },
    });
    expect(cleanSynonym({ kind: 'multi', root: 'ignored', terms: ['a b', 'c d'] })).toMatchObject({
      value: { root: null },
    });
    const inside = cleanSynonym({ kind: 'one_way', root: 'a b', terms: ['a b', 'c d'] });
    expect(inside.ok ? null : inside.problems[0]?.code).toBe('duplicate');
  });
});

describe('cleanPin', () => {
  it('cleans the query and orders the pinned services by position', () => {
    const result = cleanPin({
      query: '  UNLOCK  ',
      pinned: [
        { serviceId: 9, position: 2 },
        { serviceId: 7, position: 1 },
      ],
      hidden: [12],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        query: 'unlock',
        pinned: [
          { serviceId: 7, position: 1 },
          { serviceId: 9, position: 2 },
        ],
        hidden: [12],
      },
    });
  });

  it('refuses a repeated service or position, a hidden pinned service and an empty or long query', () => {
    const bad = cleanPin({
      query: '',
      pinned: [
        { serviceId: 1, position: 1 },
        { serviceId: 1, position: 1 },
      ],
      hidden: [1, 5, 5],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.map((p) => p.field)).toEqual([
        'query',
        'pinned.1.serviceId',
        'pinned.1.position',
        'hidden.0',
        'hidden.2',
      ]);
    }
    expect(cleanPin({ query: 'x'.repeat(101), pinned: [], hidden: [] }).ok).toBe(false);
  });
});

describe('ruleApplies and cleanHiddenTerm', () => {
  it('matches an exact rule on the whole query and a contains rule on whole words', () => {
    expect(ruleApplies({ query: 'unlock', match: 'exact' }, 'unlock')).toBe(true);
    expect(ruleApplies({ query: 'unlock', match: 'exact' }, 'sim unlock')).toBe(false);
    expect(ruleApplies({ query: 'iphone unlock', match: 'contains' }, 'att iphone unlock now')).toBe(true);
    expect(ruleApplies({ query: 'phone', match: 'contains' }, 'iphone unlock')).toBe(false);
  });

  it('cleans a hidden term to 1-64 characters', () => {
    expect(cleanHiddenTerm('  Cheap   Phones ')).toEqual({ ok: true, value: 'cheap phones' });
    expect(cleanHiddenTerm('   ').ok).toBe(false);
    expect(cleanHiddenTerm('x'.repeat(65)).ok).toBe(false);
  });
});
