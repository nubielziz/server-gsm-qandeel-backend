// The order merchants and API clients see services in (decision 063): the category's position, then the service's own position,
// then the name. One definition for the merchant lists and for the console's sort on `sort`.
import { sql } from 'drizzle-orm';
import type { ListSort } from '../../../common/contract';
import { serviceCategories } from '../db/schema';

/**
 * The order of a category: its `sort`, then its id, as one text that sorts like the pair (both are written with a fixed width), so
 * two categories with the same `sort` never interleave their services.
 *
 * Why: the first part of the order every merchant list follows (decision 063); the portal catalog, the price list and the Dhru
 * service list read it, and so does the admin list when it sorts by `sort`.
 */
export const categoryPositionSql = sql`(lpad(${serviceCategories.sort}::text, 10, '0') || lpad(${serviceCategories.id}::text, 20, '0'))`;

/**
 * Puts the keys a sort field stands for around it.
 *
 * Why: decision 063: sorting a merchant list by `category` means "category position, then the service's own position", and sorting the
 * admin list by `sort` means "category position, then `sort`, then name". The caller's contract names one field; the SQL orders by
 * several, all in the direction the caller asked for. A key the caller sent itself is not added again, so `_sort=sort,name` keeps
 * the caller's own direction for the name.
 *
 * @param sort the parsed sort keys
 * @param field the field that stands for more than one key
 * @param around the fields to put `before` and `after` it, in order
 * @returns the keys to order by (the same list when `field` is not in it)
 */
export function expandSortField(
  sort: readonly ListSort[],
  field: string,
  around: { readonly before?: readonly string[]; readonly after?: readonly string[] },
): ListSort[] {
  const sent = new Set(sort.map((key) => key.field));
  const out: ListSort[] = [];
  for (const key of sort) {
    if (key.field !== field) {
      out.push(key);
      continue;
    }
    for (const name of around.before ?? []) if (!sent.has(name)) out.push({ field: name, order: key.order });
    out.push(key);
    for (const name of around.after ?? []) if (!sent.has(name)) out.push({ field: name, order: key.order });
  }
  return out;
}
