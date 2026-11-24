// Queries on `account_legacy_ids`, the map from the old merchant and customer numbers to account ids (identity module). The table is
// named as text, not through the schema file: the same names are used by the SQL fragments of legacy-accounts.ts, which other modules
// embed in their own queries. Every function takes a DbExecutor.
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';

/** The two old number spaces the map holds. */
export type LegacyType = 'client' | 'customer';

/** One row of the map: an old number and where it points. */
export interface LegacyRow {
  readonly legacyType: LegacyType;
  readonly legacyId: number;
}

/**
 * Finds the account an old number points to.
 *
 * @param db the database or a transaction
 * @param legacyType the old number space
 * @param legacyId the old number
 * @returns the account id, or `undefined` when the map has no such number
 */
export async function findMappedAccountId(
  db: DbExecutor,
  legacyType: LegacyType,
  legacyId: number,
): Promise<number | undefined> {
  const result = await db.execute(
    sql`select account_id from account_legacy_ids where legacy_type = ${legacyType} and legacy_id = ${legacyId} limit 1`,
  );
  const accountId: unknown = result.rows[0]?.account_id;
  return accountId === undefined || accountId === null ? undefined : Number(accountId);
}

/**
 * Lists every old number that points to an account.
 *
 * @param db the database or a transaction
 * @param accountId the account id
 * @returns the rows, merchant numbers first, each space in ascending order
 */
export async function listLegacyRows(db: DbExecutor, accountId: number): Promise<LegacyRow[]> {
  const result = await db.execute(
    sql`select legacy_type, legacy_id from account_legacy_ids where account_id = ${accountId} order by legacy_type, legacy_id`,
  );
  return result.rows.map((row) => ({
    legacyType: row.legacy_type === 'customer' ? 'customer' : 'client',
    legacyId: Number(row.legacy_id),
  }));
}
