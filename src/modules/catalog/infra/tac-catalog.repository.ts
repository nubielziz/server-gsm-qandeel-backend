// Drizzle queries on `tac_catalog` (catalog module): the list with search, filter and sort, one entry, find by TAC, insert and
// update. Only the catalog module touches this table.
import { eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type NewTacCatalogEntry, type TacCatalogEntry, tacCatalog } from '../db/schema';

/** The sort fields of the TAC list. */
export type TacSortField = 'tac' | 'brand' | 'model' | 'releaseYear';

// An unknown year sorts as 0: first in ascending order, last in descending, like the 0 the console receives (catalog-8).
const COLUMNS: ListColumns = {
  tac: tacCatalog.tac,
  brand: tacCatalog.brand,
  model: tacCatalog.model,
  marketingName: tacCatalog.marketingName,
  releaseYear: sql`coalesce(${tacCatalog.releaseYear}, 0)`,
};

/**
 * Lists TAC entries.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`q` searches tac, brand, model and marketing name)
 * @returns the page and the exact total
 */
export async function listTacRows(
  db: DbExecutor,
  query: ParsedListQuery<TacSortField>,
): Promise<{ rows: TacCatalogEntry[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(tacCatalog)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, tacCatalog.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(tacCatalog)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a TAC entry by id.
 *
 * @param db the database or a transaction
 * @param id the entry id
 * @param lock lock the row `FOR UPDATE` for the rest of the transaction
 * @returns the entry, or `undefined`
 */
export async function findTacEntry(db: DbExecutor, id: number, lock = false): Promise<TacCatalogEntry | undefined> {
  const query = db.select().from(tacCatalog).where(eq(tacCatalog.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds a TAC entry by its 8 digits.
 *
 * @param db the database or a transaction
 * @param tac the 8-digit TAC
 * @returns the entry, or `undefined`
 */
export async function findTacByTac(db: DbExecutor, tac: string): Promise<TacCatalogEntry | undefined> {
  const [row] = await db.select().from(tacCatalog).where(eq(tacCatalog.tac, tac)).limit(1);
  return row;
}

/**
 * Inserts a TAC entry.
 *
 * Side effects: inserts a `tac_catalog` row.
 *
 * @param db the transaction
 * @param values the new row
 * @returns the stored row
 * @throws a unique violation of `tac_catalog_tac_uq` when the TAC is taken (a race the pre-check could not see)
 */
export async function insertTacEntry(db: DbExecutor, values: NewTacCatalogEntry): Promise<TacCatalogEntry> {
  const [row] = await db.insert(tacCatalog).values(values).returning();
  if (!row) throw new Error('Inserting a TAC entry returned no row.');
  return row;
}

/**
 * Updates a TAC entry.
 *
 * Side effects: updates the `tac_catalog` row.
 *
 * @param db the transaction
 * @param id the entry id
 * @param values the changed columns
 * @returns the stored row
 */
export async function updateTacRow(
  db: DbExecutor,
  id: number,
  values: Partial<NewTacCatalogEntry>,
): Promise<TacCatalogEntry> {
  const [row] = await db.update(tacCatalog).set(values).where(eq(tacCatalog.id, id)).returning();
  if (!row) throw new Error(`TAC entry ${id} vanished during its update.`);
  return row;
}
