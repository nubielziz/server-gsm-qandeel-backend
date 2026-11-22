// Drizzle queries on `settings`, the key/value system settings table (platform module).
import type { DbExecutor } from '../../../infra/db';
import { settings } from '../db/schema';

/**
 * Reads every setting as one flat object.
 *
 * Why: the table is small (a few dozen keys) and every reader wants a handful of them, so one read of the whole table
 * beats a query per key (decision 022 caches the result).
 *
 * @param db the database or a transaction
 * @returns key to JSON value; a key that was never set is absent
 */
export async function loadAllSettings(db: DbExecutor): Promise<Record<string, unknown>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/**
 * Writes a setting only when the key has none yet.
 *
 * Why: decision 054: the boot check of `LOOKUP_HASH_KEY` stores its marker once; two processes starting together race on the unique
 * key, and the loser keeps the winner's value.
 *
 * Side effects: inserts at most one `settings` row.
 *
 * @param db the database or a transaction
 * @param key the key
 * @param value any JSON value
 * @returns true when this call wrote the row
 */
export async function insertSettingIfAbsent(db: DbExecutor, key: string, value: unknown): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoNothing({ target: settings.key })
    .returning({ id: settings.id });
  return rows.length === 1;
}
