import { describe, expect, it } from 'bun:test';
import {
  NO_FILTERS,
  facetValues,
  filterBy,
  quoteFilterValue,
  selectedGroups,
} from '@src/modules/storefront/search/domain/filters';

describe('filterBy', () => {
  it('is empty without a selection', () => {
    expect(filterBy(NO_FILTERS)).toBe('');
    expect(selectedGroups(NO_FILTERS)).toEqual([]);
  });

  it('lower-cases brand and network, upper-cases the country and quotes text values', () => {
    const filters = {
      ...NO_FILTERS,
      brand: ['Samsung', 'SAMSUNG', 'Apple'],
      network: ['AT&T'],
      country: ['gb'],
      type: ['imei'],
    };
    expect(filterBy(filters)).toBe(
      'brand_key:=[`samsung`,`apple`] && carrier_key:=[`at&t`] && country:=[`GB`] && type:=[`imei`]',
    );
  });

  it('escapes what Typesense would read as syntax: commas, brackets, colons and backticks', () => {
    expect(quoteFilterValue('a, b] && x:=1')).toBe('`a, b] && x:=1`');
    expect(quoteFilterValue('ev`il')).toBe('`evil`');
    expect(filterBy({ ...NO_FILTERS, brand: ['`'] })).toBe('');
    expect(filterBy({ ...NO_FILTERS, brand: ['x`] || id:>0 && brand_key:=[`y'] })).toBe(
      'brand_key:=[`x] || id:>0 && brand_key:=[y`]',
    );
  });

  it('writes categories as numbers and availability and featured as booleans', () => {
    const filters = { ...NO_FILTERS, category: [3, 3, 4], availability: ['in_stock' as const], featured: true };
    expect(filterBy(filters)).toBe('category_id:=[3,4] && in_stock:=true && featured:=true');
    expect(filterBy({ ...NO_FILTERS, availability: ['on_request'] })).toBe('in_stock:=false');
  });

  it('keeps only category ids the int32 index holds and matches nothing when none is left', () => {
    expect(filterBy({ ...NO_FILTERS, category: [3, 2147483647, 2147483648, 0, -1, 9007199254740991] })).toBe(
      'category_id:=[3,2147483647]',
    );
    expect(filterBy({ ...NO_FILTERS, category: [2147483648] })).toBe('category_id:=[0]');
    expect(filterBy({ ...NO_FILTERS, category: [2147483648] }, 'category')).toBe('');
  });

  it('treats both availabilities as no restriction', () => {
    const filters = { ...NO_FILTERS, availability: ['in_stock' as const, 'on_request' as const] };
    expect(filterBy(filters)).toBe('');
    expect(selectedGroups(filters)).toEqual([]);
  });

  it('leaves out the group a facet count is asked for', () => {
    const filters = { ...NO_FILTERS, brand: ['samsung'], country: ['GB'] };
    expect(filterBy(filters, 'brand')).toBe('country:=[`GB`]');
    expect(selectedGroups(filters)).toEqual(['brand', 'country']);
  });
});

describe('facetValues', () => {
  it('reads one field and drops empty counts', () => {
    const facets = [
      {
        field_name: 'brand_key',
        counts: [
          { value: 'samsung', count: 3 },
          { value: 'apple', count: 0 },
        ],
      },
      { field_name: 'type', counts: [{ value: 'imei', count: 2 }] },
    ];
    expect(facetValues(facets, 'brand_key')).toEqual([{ value: 'samsung', count: 3 }]);
    expect(facetValues(facets, 'carrier_key')).toEqual([]);
    expect(facetValues(undefined, 'brand_key')).toEqual([]);
  });
});
