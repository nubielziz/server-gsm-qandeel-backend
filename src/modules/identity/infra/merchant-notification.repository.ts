// Drizzle queries of an account's own settings on `clients` that no other file writes (identity module): a merchant's notification
// preferences (feature 12a) and the retail profile columns of the shop's own edit (decision 064). Every function takes a DbExecutor; times
// come from the caller.
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Client, clients } from '../db/schema';
import type { RetailProfileColumns } from '../ports/account-own-profile';

/**
 * Reads an account and locks the row for the rest of the transaction.
 *
 * Why: two saves of the preferences rewrite `notification_prefs`; the lock makes them take turns, so neither overwrites the other.
 *
 * @param db the caller's transaction
 * @param id the account id
 * @returns the account, or `undefined`
 */
export async function lockClient(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1).for('update');
  return row;
}

/**
 * Saves an account's notification preferences.
 *
 * @param db the caller's transaction
 * @param id the account id
 * @param prefs the whole new `notification_prefs` object
 * @param now the time from the injected clock
 */
export async function saveNotificationPrefs(
  db: DbExecutor,
  id: number,
  prefs: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await db.update(clients).set({ notificationPrefs: prefs, updatedAt: now }).where(eq(clients.id, id));
}

/**
 * Saves the columns of the shop's own profile edit.
 *
 * Why: the account row belongs to the identity module, so the customers module changes it only through this write (decision 064); the
 * caller holds the row lock (`lockClientById`) and has judged the change.
 *
 * @param db the caller's transaction
 * @param id the account id
 * @param columns the columns to change; an empty set changes nothing
 * @param now the time from the injected clock
 * @returns the account after the write, or `undefined` when it is gone
 */
export async function saveRetailProfileColumns(
  db: DbExecutor,
  id: number,
  columns: RetailProfileColumns,
  now: Date,
): Promise<Client | undefined> {
  const values = {
    ...(columns.name === undefined ? {} : { name: columns.name }),
    ...(columns.phone === undefined ? {} : { phone: columns.phone }),
    ...(columns.country === undefined ? {} : { country: columns.country }),
    ...(columns.currency === undefined ? {} : { currency: columns.currency }),
    ...(columns.marketingOptIn === undefined ? {} : { marketingOptIn: columns.marketingOptIn }),
  };
  if (Object.keys(values).length === 0) {
    const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
    return row;
  }
  const [row] = await db
    .update(clients)
    .set({ ...values, updatedAt: now })
    .where(eq(clients.id, id))
    .returning();
  return row;
}
