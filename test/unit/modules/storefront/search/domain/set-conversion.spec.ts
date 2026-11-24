// Unit tests of the conversion of synonyms into the Typesense synonym set (feature 29, plan section 4.6 and step 0).
import { describe, expect, it } from 'bun:test';
import { synonymItems } from '@src/modules/storefront/search/domain/set-conversion';

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
