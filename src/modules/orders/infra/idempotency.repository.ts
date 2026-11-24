// Drizzle queries of the portal's idempotency store (`idempotency_keys`, orders module): lock a key for the length of a transaction, read
// what it stored and store the first answer. The table's `client_id` column holds the account id (merchants kept their ids, decision 064).
import { and, eq, sql } from 'drizzle-orm';
import type { JsonObject } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { type IdempotencyRecord, type IdempotencyScope, idempotencyKeys } from '../db/schema';

/**
 * Takes the lock of a key without waiting.
 *
 * Why: two requests with the same key and the same account must not both place the order. The lock lasts until the transaction ends,
 * so a second request that arrives while the first still runs does not wait for it (and then probably time out): it learns at once that
 * the key is in use (`409 IDEMPOTENCY_IN_PROGRESS`) and tries again. Once the first commits its row is visible and the lock is free.
 *
 * @param db the transaction
 * @param accountId the account (a merchant rank)
 * @param key the `Idempotency-Key`
 * @returns true when this transaction now holds the lock, false when another request holds it
 */
export async function tryLockIdempotencyKey(db: DbExecutor, accountId: number, key: string): Promise<boolean> {
  const result = await db.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`idempotency:${accountId}:${key}`}, 0)) as locked`,
  );
  return result.rows[0]?.locked === true;
}

/**
 * Reads what a key stored.
 *
 * @param db the transaction (after {@link tryLockIdempotencyKey})
 * @param accountId the account (a merchant rank)
 * @param key the `Idempotency-Key`
 * @returns the stored answer, or `undefined` when the key was never used
 */
export async function findIdempotencyRecord(
  db: DbExecutor,
  accountId: number,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.clientId, accountId), eq(idempotencyKeys.key, key)))
    .limit(1);
  return row;
}

/**
 * Stores the first answer of a key.
 *
 * @param db the transaction that placed the orders
 * @param row the account, key, scope, request hash and the status and body to replay
 */
export async function insertIdempotencyRecord(
  db: DbExecutor,
  row: {
    readonly accountId: number;
    readonly key: string;
    readonly scope: IdempotencyScope;
    readonly requestHash: string;
    readonly status: number;
    readonly response: JsonObject;
    /** the clock's time (decision 031): the retention window of the purge counts from it */
    readonly createdAt: Date;
  },
): Promise<void> {
  const { accountId, ...rest } = row;
  await db.insert(idempotencyKeys).values({ ...rest, clientId: accountId, updatedAt: row.createdAt });
}

/**
 * Forgets one expired key of one account: deletes its stored answer.
 *
 * Why: B166. The 7-day window is exact, not "up to a day late": the placement that finds an answer older than the window forgets it on
 * the spot and then runs as a first request, so a key never replays (or answers `409 IDEMPOTENCY_KEY_REUSED`) after its window.
 *
 * Side effects: deletes the `idempotency_keys` row of the account and key.
 *
 * @param db the placement's transaction (after {@link tryLockIdempotencyKey})
 * @param accountId the account (a merchant rank)
 * @param key the `Idempotency-Key`
 */
export async function forgetIdempotencyKey(db: DbExecutor, accountId: number, key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.clientId, accountId), eq(idempotencyKeys.key, key)));
}

/**
 * Deletes up to `limit` stored answers created before `cutoff`.
 *
 * Why: B166. A stored answer keeps the replayed body, delivered stock codes included, so it must not outlive the window.
 *
 * Side effects: deletes `idempotency_keys` rows.
 *
 * @param db the database or a transaction
 * @param cutoff rows created before this time are deleted
 * @param limit the most rows one statement deletes
 * @returns how many rows were deleted
 */
export async function deleteIdempotencyRecordsBefore(db: DbExecutor, cutoff: Date, limit: number): Promise<number> {
  const result = await db.execute(sql`
    delete from idempotency_keys
    where id in (
      select id from idempotency_keys
      where created_at < ${cutoff.toISOString()}::timestamptz
      order by created_at
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}
