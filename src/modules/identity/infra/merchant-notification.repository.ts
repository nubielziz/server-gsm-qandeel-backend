// Drizzle queries of a merchant's notification settings on `clients` (identity module, feature 12a): the preferences. Every function takes a
// DbExecutor; times come from the caller.
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type Client, clients } from '../db/schema';

/**
 * Reads a merchant and locks the row for the rest of the transaction.
 *
 * Why: two saves of the preferences rewrite `notification_prefs`; the lock makes them take turns, so neither overwrites the other.
 *
 * @param db the caller's transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined`
 */
export async function lockClient(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1).for('update');
  return row;
}

/**
 * Saves a merchant's notification preferences.
 *
 * @param db the caller's transaction
 * @param id the merchant id
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
