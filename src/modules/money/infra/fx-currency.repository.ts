// Drizzle queries on `currencies` for the exchange-rate refresh (money module): the currencies to refresh, the rate write and the
// hold of a rate that moved too far (decision 049).
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
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
 * Why: a rate within the bound of decision 049 also ends a hold of an earlier refresh.
 *
 * Side effects: updates `currencies.rate_to_base`, `rate_updated_at` and `updated_at`, and clears `rate_held_at`.
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
    .set({ rateToBase, rateUpdatedAt: now, rateHeldAt: null, updatedAt: now })
    .where(eq(currencies.id, id))
    .returning();
  if (!row) throw new Error(`Currency ${id} vanished during its rate refresh.`);
  return row;
}

/**
 * Marks a currency whose refreshed rate was held, the first time only: a currency already held keeps the time of its first refusal.
 *
 * Why: decision 049: the stored rate stays; staff see the currency as stale and the shop stops offering it until a rate is confirmed.
 *
 * Side effects: sets `currencies.rate_held_at` and `updated_at` (a guarded update: no change when already held).
 *
 * @param db the refresh's transaction (the row is locked by `listRefreshable(tx, true)`)
 * @param id the currency id
 * @param now the clock's time
 * @returns true when this call marked it (it was not held before)
 */
export async function holdRefreshedRate(db: DbExecutor, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(currencies)
    .set({ rateHeldAt: now, updatedAt: now })
    .where(and(eq(currencies.id, id), isNull(currencies.rateHeldAt)))
    .returning({ id: currencies.id });
  return rows.length > 0;
}
