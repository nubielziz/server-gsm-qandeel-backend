// Drizzle query of the ended-session purge on `sessions` (identity module).
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';

/**
 * Deletes up to `limit` sessions that ended before `cutoff`.
 *
 * Why: sessions are never deleted when they end (a revoked row keeps the audit trail readable for a while), so the table
 * grows with every sign-in. A session has ended when it was revoked, or its absolute lifetime ran out, before the cutoff.
 * Deleting in batches keeps each statement short; no other table references `sessions`.
 *
 * Side effects: deletes `sessions` rows.
 *
 * @param db the database or a transaction
 * @param cutoff sessions that ended before this time are deleted
 * @param limit the most rows one statement deletes
 * @returns how many rows were deleted
 */
export async function deleteEndedSessions(db: DbExecutor, cutoff: Date, limit: number): Promise<number> {
  const result = await db.execute(sql`
    delete from sessions
    where id in (
      select id from sessions
      where expires_at < ${cutoff.toISOString()}::timestamptz
         or revoked_at < ${cutoff.toISOString()}::timestamptz
      order by id
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}
