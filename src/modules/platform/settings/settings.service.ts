// The settings table (platform module): other modules read and write a setting through this service, never the table.
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { type DbExecutor, DbService, schema as s } from '../../../infra/db';

/**
 * Reads system settings (the `settings` table: flat key and JSON value pairs).
 *
 * Why: the platform module owns `settings` (map domain G), but other modules need single values: identity reads
 * `adminAllowlistOnly` for the IP rules, the pipeline reads `maintenance`. They call this service, which keeps the table
 * private (decision 016). The routes that write settings (`PATCH /admin/settings`, the guarded switches) arrive with
 * their features and invalidate whatever cache holds a value after their commit.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService) {}

  /**
   * Reads the raw JSON value of one setting.
   *
   * Why: a key that was never set is simply absent (the console treats it that way too, ALIGNMENT § 9); the caller owns
   * the meaning of its own key and its default.
   *
   * @param key the camelCase key, for example `adminAllowlistOnly` or `maintenance`
   * @param executor the database or the transaction to read with (default: the pool)
   * @returns the stored JSON value, or `undefined` when the key is not set
   * @throws {Error} when Postgres cannot be reached
   */
  async get(key: string, executor: DbExecutor = this.db.db): Promise<unknown> {
    const rows = await executor
      .select({ value: s.settings.value })
      .from(s.settings)
      .where(eq(s.settings.key, key))
      .limit(1);
    return rows[0]?.value;
  }

  /**
   * Writes the JSON value of one setting (insert or replace).
   *
   * Why: the routes that own a guarded key write it through the platform module: `PUT /admin/access/restriction` stores
   * `adminAllowlistOnly` after its lock-out check, `PATCH /admin/settings` stores the allow-listed keys. The caller invalidates
   * whatever cache holds the key, after its commit (decision 022).
   *
   * Side effects: upserts one `settings` row.
   *
   * @param executor the caller's transaction
   * @param key the camelCase key
   * @param value any JSON value
   * @returns the value the key held before, or `undefined` when it was never set
   */
  async set(executor: DbExecutor, key: string, value: unknown): Promise<unknown> {
    const before = await this.get(key, executor);
    await executor
      .insert(s.settings)
      .values({ key, value })
      // updated_at is bookkeeping (decision 031): the database stamps it, as it does for the insert default.
      .onConflictDoUpdate({ target: s.settings.key, set: { value, updatedAt: sql`now()` } });
    return before;
  }
}
