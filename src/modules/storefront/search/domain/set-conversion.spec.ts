// Unit tests of the conversion of synonyms and pins into Typesense sets (feature 29, plan section 4.6 and step 0).
import { describe, expect, it } from 'bun:test';
import { curationItems, synonymItems } from './set-conversion';

describe('synonymItems', () => {
  it('converts enabled rows, one-way with its root, in id order', () => {
    expect(
      synonymItems([
        { id: 3, kind: 'one_way', root: 'smartphone', terms: ['iphone', 'android'], isEnabled: true },
        { id: 1, kind: 'multi', root: null, terms: ['frp', 'google account lock'], isEnabled: true },
        { id: 2, kind: 'multi', root: null, terms: ['a', 'b'], isEnabled: false },
      ]),
    ).toEqual([
      { id: 's1', synonyms: ['frp', 'google account lock'] },
      { id: 's3', root: 'smartphone', synonyms: ['iphone', 'android'] },
    ]);
  });
});

describe('curationItems', () => {
  it('keeps every query word for the organic part and applies the page filters to pins (step 0)', () => {
    const [item] = curationItems([
      {
        id: 7,
        query: 'unlock',
        match: 'contains',
        pinned: [
          { serviceId: 12, position: 2 },
          { serviceId: 10, position: 1 },
        ],
        hidden: [99],
        startsAt: new Date('2026-11-16T00:00:00.000Z'),
        endsAt: null,
        isEnabled: true,
      },
    ]);
    expect(item).toEqual({
      id: 'p7',
      rule: { query: 'unlock', match: 'contains' },
      includes: [
        { id: '10', position: 1 },
        { id: '12', position: 2 },
      ],
      excludes: [{ id: '99' }],
      filter_curated_hits: true,
      remove_matched_tokens: false,
      effective_from_ts: Math.floor(Date.parse('2026-11-16T00:00:00.000Z') / 1000),
    });
  });

  it('leaves disabled pins out', () => {
    expect(
      curationItems([
        {
          id: 1,
          query: 'x',
          match: 'exact',
          pinned: [],
          hidden: [],
          startsAt: null,
          endsAt: null,
          isEnabled: false,
        },
      ]),
    ).toEqual([]);
  });
});
