// Drizzle queries on tax_rates (map domain E, routes /admin/tax-rates): list with sort, search and exact count, find,
// insert, update, the windows of one country and region, and the lock that serialises their changes. Only the money module
// touches this table.
import { and, asc, desc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { type NewTaxRate, type TaxRate, taxRates } from '../db/schema';
import { escapeLike } from '../domain/ledger-search';

/** The sort fields of the tax rate list. */
export type TaxRateSortField = 'country' | 'validFrom' | 'ratePercent' | 'createdAt';

const SORT_COLUMNS: Readonly<Record<TaxRateSortField, AnyPgColumn>> = {
  country: taxRates.country,
  validFrom: taxRates.validFrom,
  ratePercent: taxRates.ratePercent,
  createdAt: taxRates.createdAt,
};

// The first key of the two-key advisory lock: tax rate windows (the second key is the hash of country and region).
const TAX_WINDOW_LOCK = 24_101;

/**
 * Lists tax rates.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches country and label)
 * @returns the page of rows and the number matching the search
 */
export async function listTaxRateRows(
  db: DbExecutor,
  query: ParsedListQuery<TaxRateSortField>,
): Promise<{ rows: TaxRate[]; total: number }> {
  const pattern = query.search ? `%${escapeLike(query.search.text)}%` : undefined;
  const where = pattern ? or(ilike(taxRates.country, pattern), ilike(taxRates.label, pattern)) : undefined;
  const lastOrder = query.sort[query.sort.length - 1]?.order ?? 'asc';
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(taxRates)
      .where(where)
      .orderBy(
        ...query.sort.map((sort) => (sort.order === 'asc' ? asc : desc)(SORT_COLUMNS[sort.field])),
        (lastOrder === 'asc' ? asc : desc)(taxRates.id),
      )
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(taxRates)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a tax rate by id.
 *
 * @param db the database or a transaction
 * @param id the row id
 * @param lock lock the row `FOR UPDATE` for the rest of the transaction
 * @returns the row, or `undefined`
 */
export async function findTaxRateRow(db: DbExecutor, id: number, lock = false): Promise<TaxRate | undefined> {
  const query = db.select().from(taxRates).where(eq(taxRates.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Serialises the changes of one country and region until the transaction ends.
 *
 * Why: the overlap check reads the other windows and then writes; two requests adding windows for the same country and
 * region at once must not both pass it. An advisory lock covers a pair that has no row yet, which a row lock cannot.
 *
 * Side effects: takes `pg_advisory_xact_lock` (released at commit or rollback).
 *
 * @param db the caller's transaction
 * @param country the country code
 * @param region the region, '' for the whole country
 */
export async function lockTaxWindows(db: DbExecutor, country: string, region: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${TAX_WINDOW_LOCK}, hashtext(${`${country}|${region}`}))`);
}

/**
 * Reads the windows of a country and region, leaving one row out.
 *
 * @param db the caller's transaction (after {@link lockTaxWindows})
 * @param country the country code
 * @param region the region, '' for the whole country
 * @param exceptId a row to leave out (the one being changed), if any
 * @returns the other rows of that country and region
 */
export async function otherTaxWindows(
  db: DbExecutor,
  country: string,
  region: string,
  exceptId?: number,
): Promise<TaxRate[]> {
  return db
    .select()
    .from(taxRates)
    .where(
      and(
        eq(taxRates.country, country),
        eq(taxRates.region, region),
        exceptId === undefined ? undefined : ne(taxRates.id, exceptId),
      ),
    );
}

/**
 * Inserts a tax rate.
 *
 * Side effects: inserts a `tax_rates` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertTaxRateRow(db: DbExecutor, row: NewTaxRate): Promise<TaxRate> {
  const [created] = await db.insert(taxRates).values(row).returning();
  return created!;
}

/**
 * Updates a tax rate.
 *
 * Side effects: updates the `tax_rates` row.
 *
 * @param db the caller's transaction
 * @param id the row id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateTaxRateRow(db: DbExecutor, id: number, changes: Partial<NewTaxRate>): Promise<TaxRate> {
  const [updated] = await db.update(taxRates).set(changes).where(eq(taxRates.id, id)).returning();
  return updated!;
}
