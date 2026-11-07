// Drizzle queries on imei_checks for the storefront check (feature 14a): the new row of each check.
import type { DbExecutor } from '../../../infra/db';
import { type ImeiCheck, type NewImeiCheck, imeiChecks } from '../db/schema';

/**
 * Inserts a check.
 *
 * @param db the database or a transaction
 * @param values the row
 * @returns the stored row
 */
export async function insertCheck(db: DbExecutor, values: NewImeiCheck): Promise<ImeiCheck> {
  const [row] = await db.insert(imeiChecks).values(values).returning();
  return row!;
}
