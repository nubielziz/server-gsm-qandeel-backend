// Reads of the orders table that say something about the account that bought (decision 064), and the one narrowing the money paths of the
// order engine need: the wallet ports of the money module take a transaction, while the engine's use cases are typed with the wider
// executor. Reads only.
import { and, eq, inArray, or } from 'drizzle-orm';
import type { DbExecutor, Transaction } from '../../../infra/db';
import { orders } from '../db/schema';

/**
 * Tells whether an account has an order in flight, whatever door it came through.
 *
 * Why: decision 064: the `live_order` blocker of the rank change. An order that is `pending` or `processing` (a held, queued, sent or
 * manual one) has its price on the merchant hold or its money in customer funds, and a completed order with a verification request open can
 * still be refunded or reopened; none of them may meet a crossing from one wallet kind to the other. The account id is the buyer, so the
 * orders of a guest row that shares an email with the account are not counted (a guest row is another account).
 *
 * @param db the rank change's transaction (after the account row and its ledger accounts are locked)
 * @param accountId the account
 * @returns true when at least one such order exists
 */
export async function hasLiveOrder(db: DbExecutor, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.accountId, accountId),
        or(
          inArray(orders.status, ['pending', 'processing']),
          and(eq(orders.status, 'completed'), eq(orders.verificationStatus, 'requested')),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Narrows an executor to the transaction it must be.
 *
 * Why: every money path of the order engine runs inside the caller's transaction (the account row lock is held until it ends, and a
 * posting outside one would not be atomic), but the use cases are typed with `DbExecutor` so the jobs and the suppliers module can pass
 * theirs. `AccountWallets` takes a `Transaction`, so this is the one place the type is checked at run time.
 *
 * @param db the executor a use case was given
 * @returns the same object, typed as the transaction it is
 * @throws {Error} when the executor is not a transaction (a programming error, never a client error)
 */
export function asTransaction(db: DbExecutor): Transaction {
  if (typeof (db as { rollback?: unknown }).rollback !== 'function') {
    throw new Error('This money path of the order engine must run inside a transaction.');
  }
  return db as Transaction;
}
