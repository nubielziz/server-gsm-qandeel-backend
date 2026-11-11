// Tests of the price sort of the public service list: ascending, descending, ties keep the SQL order, earlier keys group the rows.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import type { ServiceListing } from '../db/schema';
import { type PricedListing, applyPriceSort } from './price-sort';

const listing = (id: number, overrides: Partial<ServiceListing> = {}) =>
  ({
    id,
    isFeatured: false,
    sort: 0,
    publicTitle: `t${id}`,
    sales30d: 0,
    listedAt: null,
    ...overrides,
  }) as ServiceListing;
const item = (id: number, gross: string, overrides: Partial<ServiceListing> = {}): PricedListing => ({
  listing: listing(id, overrides),
  gross: Money.of(gross),
});
const ids = (rows: ServiceListing[]) => rows.map((row) => row.id);

describe('applyPriceSort', () => {
  const rows = [item(1, '5.0000'), item(2, '3.0000'), item(3, '5.0000'), item(4, '1.0000')];

  it('returns the SQL order when price is not a sort key', () => {
    expect(ids(applyPriceSort(rows, [{ field: 'title', order: 'asc' }]))).toEqual([1, 2, 3, 4]);
  });

  it('sorts ascending and keeps the SQL order among equal prices', () => {
    expect(ids(applyPriceSort(rows, [{ field: 'price', order: 'asc' }]))).toEqual([4, 2, 1, 3]);
  });

  it('sorts descending and keeps the SQL order among equal prices', () => {
    expect(ids(applyPriceSort(rows, [{ field: 'price', order: 'desc' }]))).toEqual([1, 3, 2, 4]);
  });

  it('sorts by price only inside rows that tie on the keys before it', () => {
    const featured = [
      item(1, '9.0000', { isFeatured: true }),
      item(2, '2.0000', { isFeatured: true }),
      item(3, '1.0000'),
    ];
    expect(
      ids(
        applyPriceSort(featured, [
          { field: 'featured', order: 'desc' },
          { field: 'price', order: 'asc' },
        ]),
      ),
    ).toEqual([2, 1, 3]);
  });

  it('compares prices as exact decimals', () => {
    const exact = [item(1, '10.0000'), item(2, '9.9999')];
    expect(ids(applyPriceSort(exact, [{ field: 'price', order: 'asc' }]))).toEqual([2, 1]);
  });
});
