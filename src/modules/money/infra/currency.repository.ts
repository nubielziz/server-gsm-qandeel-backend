// Drizzle queries on currencies (map domain E, routes /admin/currencies): list with filters, sort, search and exact count,
// find, insert and update. Only the money module touches this table.
import { type SQL, and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { type Currency, type NewCurrency, currencies } from '../db/schema';
import { escapeLike } from '../domain/ledger-search';

/** The sort fields of the currency list. */
export type CurrencySortField = 'code' | 'name' | 'rateToBase' | 'rateUpdatedAt' | 'createdAt';

const SORT_COLUMNS: Readonly<Record<CurrencySortField, AnyPgColumn>> = {
  code: currencies.code,
  name: currencies.name,
  rateToBase: currencies.rateToBase,
  rateUpdatedAt: currencies.rateUpdatedAt,
  createdAt: currencies.createdAt,
};

function filterCondition(filter: ParsedFilter): SQL | undefined {
  const column = filter.field === 'isStorefront' ? currencies.isStorefront : currencies.isActive;
  const [value] = filter.values;
  return typeof value === 'boolean' ? eq(column, value) : undefined;
}

/**
 * Lists currencies.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches code and name)
 * @returns the page of currencies and the number matching the filters
 */
export async function listCurrencies(
  db: DbExecutor,
  query: ParsedListQuery<CurrencySortField>,
): Promise<{ rows: Currency[]; total: number }> {
  const pattern = query.search ? `%${escapeLike(query.search.text)}%` : undefined;
  const where = and(
    ...query.filters.map(filterCondition),
    pattern ? or(ilike(currencies.code, pattern), ilike(currencies.name, pattern)) : undefined,
  );
  const lastOrder = query.sort[query.sort.length - 1]?.order ?? 'asc';
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(currencies)
      .where(where)
      .orderBy(
        ...query.sort.map((sort) => (sort.order === 'asc' ? asc : desc)(SORT_COLUMNS[sort.field])),
        (lastOrder === 'asc' ? asc : desc)(currencies.id),
      )
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(currencies)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a currency by id.
 *
 * @param db the database or a transaction
 * @param id the currency id
 * @param lock lock the row `FOR UPDATE` for the rest of the transaction
 * @returns the row, or `undefined`
 */
export async function findCurrency(db: DbExecutor, id: number, lock = false): Promise<Currency | undefined> {
  const query = db.select().from(currencies).where(eq(currencies.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds currencies by code.
 *
 * @param db the database or a transaction
 * @param codes the ISO codes
 * @returns the rows that exist
 */
export async function findCurrenciesByCode(db: DbExecutor, codes: readonly string[]): Promise<Currency[]> {
  return codes.length === 0
    ? []
    : db
        .select()
        .from(currencies)
        .where(inArray(currencies.code, [...codes]));
}

/**
 * Inserts a currency.
 *
 * Side effects: inserts a `currencies` row.
 *
 * @param db the transaction
 * @param values the new row
 * @returns the stored row
 */
export async function insertCurrency(db: DbExecutor, values: NewCurrency): Promise<Currency> {
  const [row] = await db.insert(currencies).values(values).returning();
  if (!row) throw new Error('Inserting a currency returned no row.');
  return row;
}

/**
 * Updates a currency.
 *
 * Side effects: updates the `currencies` row.
 *
 * @param db the transaction
 * @param id the currency id
 * @param values the changed columns
 * @returns the stored row
 */
export async function updateCurrency(db: DbExecutor, id: number, values: Partial<NewCurrency>): Promise<Currency> {
  const [row] = await db.update(currencies).set(values).where(eq(currencies.id, id)).returning();
  if (!row) throw new Error(`Currency ${id} vanished during its update.`);
  return row;
}
