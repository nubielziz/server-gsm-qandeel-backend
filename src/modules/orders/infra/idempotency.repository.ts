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
  },
): Promise<void> {
  await db.insert(idempotencyKeys).values(row);
}
