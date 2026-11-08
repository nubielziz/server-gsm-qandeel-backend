// The transaction helper with post-commit callbacks (decisions 022, 024): one place that opens a transaction, hands the
// callback `tx`, and runs the registered `afterCommit` callbacks only once the commit has succeeded.
import { Logger } from '@nestjs/common';
import type { Database, Transaction } from './database';

/** Isolation levels a use case may ask for; the default is `read committed`. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Options of {@link runInTransaction}. */
export interface TransactionOptions {
  /** Isolation level of this transaction; omit for the Postgres default (`read committed`). */
  readonly isolation?: IsolationLevel;
  /**
   * Open the transaction `READ ONLY`: Postgres refuses any write in it. Use it with `repeatable read` for a report whose queries
   * must see one snapshot of the data.
   */
  readonly readOnly?: boolean;
}

/** What a transaction callback receives. */
export interface TransactionContext {
  /** The transaction handle: pass it to every repository and public service the use case calls. */
  readonly tx: Transaction;
  /**
   * Registers a callback that runs only after this transaction commits, in registration order.
   *
   * Why: decision 022 deletes cache keys after the commit, never before (a rolled-back change must not evict a good
   * entry, and a reader must not re-cache the old value). A callback that throws is logged and does not stop the
   * others, because the data is already committed.
   *
   * @throws {Error} when called after the transaction has ended
   */
  afterCommit(callback: () => void | Promise<void>): void;
}

/** The part of {@link Database} the helper needs; lets unit tests pass a fake without a pool. */
export type TransactionRunner = Pick<Database, 'transaction'>;

const logger = new Logger('Transaction');

/**
 * Runs `fn` in one database transaction and then its post-commit callbacks.
 *
 * Why: decision 020 and 024 want every state change, its ledger posting and its outbox row in one commit; callers that
 * also touch the cache register the invalidation with `afterCommit` so it happens only for a committed change.
 *
 * @param db the Drizzle database (or any object with `transaction`)
 * @param fn the work; its return value becomes the result. Throwing rolls everything back and skips the callbacks
 * @param options isolation level
 * @returns what `fn` returned
 * @throws whatever `fn` threw, or the database error of a failed commit (no callback runs then)
 */
export async function runInTransaction<T>(
  db: TransactionRunner,
  fn: (context: TransactionContext) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const callbacks: Array<() => void | Promise<void>> = [];
  let open = true;
  let result: T;
  try {
    result = await db.transaction(
      (tx) =>
        fn({
          tx,
          afterCommit: (callback) => {
            if (!open) throw new Error('afterCommit() was called after the transaction ended');
            callbacks.push(callback);
          },
        }),
      options.isolation || options.readOnly
        ? {
            ...(options.isolation ? { isolationLevel: options.isolation } : {}),
            ...(options.readOnly ? { accessMode: 'read only' as const } : {}),
          }
        : undefined,
    );
  } finally {
    open = false;
  }
  // The commit succeeded: from here on a failing callback cannot undo the change, so it is only logged.
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      logger.error(`afterCommit callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
