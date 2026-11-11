// Sorting the public service list by price (feature 22): the price is worked out in code, so the SQL order is completed here.
// Pure functions; the integration test of the catalog walks both directions with stable paging.
import type { ListSort } from '../../../common/contract';
import type { Money } from '../../../common/money';
import type { ServiceListing } from '../db/schema';

/** A listing with the price the visitor sees for one unit (`gross` in the chosen currency). */
export interface PricedListing {
  readonly listing: ServiceListing;
  readonly gross: Money;
}

/** The value a non-price sort field orders a listing by (the SQL column behind it); used to find rows the SQL order ties. */
function sortValue(listing: ServiceListing, field: string): string | number | boolean | null {
  switch (field) {
    case 'featured':
      return listing.isFeatured;
    case 'sort':
      return listing.sort;
    case 'title':
      return listing.publicTitle;
    case 'popular':
      return listing.sales30d;
    case 'listedAt':
      return listing.listedAt?.getTime() ?? null;
    default:
      return null;
  }
}

/**
 * Orders listings that SQL already ordered by every sort key except `price`, so that the price takes its place in the sort.
 *
 * Why: `_sort=price` (and `_sort=featured,price`) cannot be an `ORDER BY` because the price is `max(retail row, floor)` plus tax and
 * the exchange rate. The rows arrive ordered by the keys without `price` (the id last). Rows that tie on every key before `price` are
 * re-ordered by price in the requested direction; the sort is stable, so equal prices keep the SQL order, and the keys after `price`
 * only break ties, which the SQL order already did. A sort without `price` returns the rows unchanged.
 *
 * @param items the priced listings in SQL order
 * @param sort the requested sort keys, `price` among them
 * @returns the listings in the final order
 */
export function applyPriceSort(items: readonly PricedListing[], sort: readonly ListSort[]): ServiceListing[] {
  const at = sort.findIndex((key) => key.field === 'price');
  if (at === -1) return items.map((item) => item.listing);
  const order = sort[at]!.order === 'desc' ? -1 : 1;
  const before = sort.slice(0, at).map((key) => key.field);
  const groupOf = (item: PricedListing) => JSON.stringify(before.map((field) => sortValue(item.listing, field)));
  const out: ServiceListing[] = [];
  let group: PricedListing[] = [];
  let groupKey: string | undefined;
  const flush = () => {
    group.sort((a, b) => a.gross.cmp(b.gross) * order);
    for (const item of group) out.push(item.listing);
    group = [];
  };
  for (const item of items) {
    const key = groupOf(item);
    if (groupKey !== undefined && key !== groupKey) flush();
    groupKey = key;
    group.push(item);
  }
  flush();
  return out;
}
