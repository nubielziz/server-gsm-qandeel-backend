// Drizzle queries on `currencies` for the exchange-rate refresh (money module): the currencies to refresh and the rate write.
import { and, asc, eq, ne } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Currency, currencies } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';

/**
 * Lists the active non-base currencies, by code.
 *
 * Why: customers.md refresh-fx: "refreshes every active non-base currency (at least every isStorefront one) in one call";
 * the base currency's rate is 1 and never changes.
 *
 * @param db the database or a transaction
 * @param lock lock the rows `FOR UPDATE` for the rest of the transaction (the write that follows)
 * @returns the currencies
 */
export async function listRefreshable(db: DbExecutor, lock = false): Promise<Currency[]> {
  const query = db
    .select()
    .from(currencies)
    .where(and(eq(currencies.isActive, true), ne(currencies.code, BASE_CURRENCY)))
    .orderBy(asc(currencies.code));
  return lock ? query.for('update') : query;
}

/**
 * Stamps a refreshed rate.
 *
 * Side effects: updates `currencies.rate_to_base`, `rate_updated_at` and `updated_at`.
 *
 * @param db the transaction
 * @param id the currency id
 * @param rateToBase the decimal text of the new rate
 * @param now the clock's time (decision 031)
 * @returns the stored row
 */
export async function writeRefreshedRate(db: DbExecutor, id: number, rateToBase: string, now: Date): Promise<Currency> {
  const [row] = await db
    .update(currencies)
    .set({ rateToBase, rateUpdatedAt: now, updatedAt: now })
    .where(eq(currencies.id, id))
    .returning();
  if (!row) throw new Error(`Currency ${id} vanished during its rate refresh.`);
  return row;
}
