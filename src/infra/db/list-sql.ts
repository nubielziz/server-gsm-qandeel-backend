// Turns a parsed list request (filters, search, sort of the simple-rest dialect, ALIGNMENT § 2) into SQL conditions and an
// ORDER BY. Repositories give it the map from wire field names to columns, so the whitelist of the contract is the only way in.
import { type SQL, asc, desc, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type { ListSort, ParsedFilter, ParsedListQuery } from '../../common/contract';

/** A column or SQL expression a wire field maps to. */
export type ListColumn = AnyColumn | SQL;

/** Wire field name (camelCase, dotted paths allowed, as the contract names it) to the column that holds it. */
export type ListColumns = Readonly<Record<string, ListColumn>>;

/**
 * Escapes the characters that mean something in a `LIKE` pattern.
 *
 * Why: `q` and `_like` values are raw user text; `%` and `_` must match themselves (ALIGNMENT § 2).
 *
 * @param text the text to match literally
 * @returns the text with `\`, `%` and `_` escaped for `LIKE ... ESCAPE '\'`
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function columnOf(columns: ListColumns, field: string): ListColumn {
  const column = columns[field];
  // The contract whitelists the fields, so a missing mapping is a programming error, never user input.
  if (!column) throw new Error(`The list has no column for the field "${field}".`);
  return column;
}

function values(list: readonly unknown[]): SQL {
  return sql.join(
    list.map((value) => sql`${value}`),
    sql`, `,
  );
}

function condition(column: ListColumn, filter: ParsedFilter): SQL {
  const [first] = filter.values;
  const many = filter.values.length > 1;
  switch (filter.op) {
    case 'eq':
      return many ? sql`${column} in (${values(filter.values)})` : sql`${column} = ${first}`;
    case 'ne':
      return many ? sql`${column} not in (${values(filter.values)})` : sql`${column} <> ${first}`;
    case 'gte':
      return sql`${column} >= ${first}`;
    case 'lte':
      return sql`${column} <= ${first}`;
    case 'gt':
      return sql`${column} > ${first}`;
    case 'lt':
      return sql`${column} < ${first}`;
    case 'like':
      return sql`${column} ilike ${`%${escapeLike(String(first))}%`}`;
  }
}

/**
 * Builds the `WHERE` of a list: the contract's filters and `q`, joined with `and`, plus conditions the endpoint adds itself.
 *
 * Why: every list endpoint translates the same dialect; one function keeps the rules (IN for repeated keys, NOT IN for
 * repeated `_ne`, case-insensitive escaped contains for `q`) in one place and testable.
 *
 * @param query the parsed list request (filters and search)
 * @param columns the wire field to column map of this endpoint
 * @param extra more conditions (visibility rules, date windows); `undefined` entries are skipped
 * @returns the condition, or `undefined` when nothing restricts the list
 */
export function listWhere(
  query: Pick<ParsedListQuery, 'filters' | 'search'>,
  columns: ListColumns,
  ...extra: ReadonlyArray<SQL | undefined>
): SQL | undefined {
  const conditions: SQL[] = query.filters.map((filter) => condition(columnOf(columns, filter.field), filter));
  if (query.search) {
    const pattern = `%${escapeLike(query.search.text)}%`;
    const any = sql.join(
      query.search.fields.map((field) => sql`${columnOf(columns, field)} ilike ${pattern}`),
      sql` or `,
    );
    conditions.push(sql`(${any})`);
  }
  for (const item of extra) if (item) conditions.push(item);
  return conditions.length === 0 ? undefined : sql.join(conditions, sql` and `);
}

/**
 * Builds the `ORDER BY` of a list: the requested sort, then the tie-breakers.
 *
 * Why: ALIGNMENT § 2 wants a stable order (the id breaks ties), so pages never repeat or skip a row. Nulls sort last in both
 * directions, so "last login" lists put people who never signed in at the end either way.
 *
 * @param sort the parsed sort keys (a whitelisted subset of `columns`)
 * @param columns the wire field to column map of this endpoint
 * @param tiebreak the primary key column, ordered like the first sort key, appended last
 * @returns the expressions for `.orderBy(...)`
 */
export function listOrderBy(sort: readonly ListSort[], columns: ListColumns, tiebreak: ListColumn): SQL[] {
  const keys = sort.map((key) => {
    const column = columnOf(columns, key.field);
    return sql`${column} ${sql.raw(key.order)} nulls last`;
  });
  const last = sort[0]?.order === 'desc' ? desc(tiebreak) : asc(tiebreak);
  return [...keys, last];
}
