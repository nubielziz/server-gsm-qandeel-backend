// Read side of the settings table (platform module): other modules read a setting through this service, never the table.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
}
