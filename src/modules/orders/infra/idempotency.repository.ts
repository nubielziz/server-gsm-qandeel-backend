// Drizzle queries of the REST v1 idempotency store (`idempotency_keys`, orders module): lock a key for the length of a transaction, read
// what it stored and store the first answer.
import { and, eq, sql } from 'drizzle-orm';
import type { JsonObject } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { type IdempotencyRecord, type IdempotencyScope, idempotencyKeys } from '../db/schema';

/**
 * Takes the lock of a key without waiting.
 *
 * Why: two requests with the same key and the same merchant must not both place the order. The lock lasts until the transaction ends,
 * so a second request that arrives while the first still runs does not wait for it (and then probably time out): it learns at once that
 * the key is in use (`409 IDEMPOTENCY_IN_PROGRESS`) and tries again. Once the first commits its row is visible and the lock is free.
 *
 * @param db the transaction
 * @param clientId the merchant
 * @param key the `Idempotency-Key`
 * @returns true when this transaction now holds the lock, false when another request holds it
 */
export async function tryLockIdempotencyKey(db: DbExecutor, clientId: number, key: string): Promise<boolean> {
  const result = await db.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`idempotency:${clientId}:${key}`}, 0)) as locked`,
  );
  return result.rows[0]?.locked === true;
}

/**
 * Reads what a key stored.
 *
 * @param db the transaction (after {@link tryLockIdempotencyKey})
 * @param clientId the merchant
 * @param key the `Idempotency-Key`
 * @returns the stored answer, or `undefined` when the key was never used
 */
export async function findIdempotencyRecord(
  db: DbExecutor,
  clientId: number,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.clientId, clientId), eq(idempotencyKeys.key, key)))
    .limit(1);
  return row;
}

/**
 * Stores the first answer of a key.
 *
 * @param db the transaction that placed the orders
 * @param row the merchant, key, scope, request hash and the status and body to replay
 */
export async function insertIdempotencyRecord(
  db: DbExecutor,
  row: {
    readonly clientId: number;
    readonly key: string;
    readonly scope: IdempotencyScope;
    readonly requestHash: string;
    readonly status: number;
    readonly response: JsonObject;
    /** the clock's time (decision 031): the retention window of the purge counts from it */
    readonly createdAt: Date;
  },
): Promise<void> {
  await db.insert(idempotencyKeys).values({ ...row, updatedAt: row.createdAt });
}

/**
 * Forgets one expired key of one merchant: deletes its stored answer and clears it from the merchant's orders.
 *
 * Why: B166. The 7-day window is exact, not "up to a day late": the placement that finds an answer older than the window forgets it on
 * the spot and then runs as a first request, so a key never replays (or answers `409 IDEMPOTENCY_KEY_REUSED`) after its window. The orders
 * are cleared first, as in the daily job, because `orders.idempotency_key` is unique per merchant and the new placement may reuse the key.
 *
 * Side effects: sets `orders.idempotency_key` to NULL (`updated_at` is left alone: housekeeping, not a change of the order) and deletes
 * the `idempotency_keys` row of the merchant and key.
 *
 * @param db the placement's transaction (after {@link tryLockIdempotencyKey})
 * @param clientId the merchant
 * @param key the `Idempotency-Key`
 */
export async function forgetIdempotencyKey(db: DbExecutor, clientId: number, key: string): Promise<void> {
  await db.execute(
    sql`update orders set idempotency_key = null where client_id = ${clientId} and idempotency_key = ${key}`,
  );
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.clientId, clientId), eq(idempotencyKeys.key, key)));
}

/**
 * Clears the Idempotency-Key of up to `limit` orders placed before `cutoff`.
 *
 * Why: B166. `orders.idempotency_key` is unique per merchant, so while it stays on an old order the key could never be used again; the
 * window ends for the order and for the stored answer together. Clear the orders before deleting the answers
 * ({@link deleteIdempotencyRecordsBefore}): the other way round, a request in the gap would find no stored answer and then hit the
 * unique index of the old order. `updated_at` is left alone: this is housekeeping, not a change of the order.
 *
 * Side effects: updates `orders.idempotency_key` to NULL.
 *
 * @param db the database or a transaction
 * @param cutoff orders placed before this time lose their key
 * @param limit the most rows one statement changes
 * @returns how many orders were cleared
 */
export async function clearOrderKeysBefore(db: DbExecutor, cutoff: Date, limit: number): Promise<number> {
  const result = await db.execute(sql`
    update orders set idempotency_key = null
    where id in (
      select id from orders
      where idempotency_key is not null and placed_at < ${cutoff.toISOString()}::timestamptz
      order by placed_at
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
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
