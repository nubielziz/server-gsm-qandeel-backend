// The transaction helper with post-commit callbacks (decisions 022, 024, 037): one place that opens a transaction, hands the
// callback `tx`, and runs the registered `afterCommit` / `onCommit` callbacks only once the commit has succeeded.
import { AsyncLocalStorage } from 'node:async_hooks';
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

/** The callbacks of one {@link runInTransaction} call and where that transaction is. */
interface CommitScope {
  readonly callbacks: Array<() => void | Promise<void>>;
  state: 'open' | 'committed' | 'rolled-back';
}

const logger = new Logger('Transaction');
/** The transaction of the current async context; a savepoint (`tx.transaction`) runs in the same context, so it shares it. */
const scopes = new AsyncLocalStorage<CommitScope>();

/** Runs one callback whose data is committed: a failure is logged, never thrown (nothing can undo the commit). */
function runCommitted(callback: () => void | Promise<void>): void {
  const failed = (error: unknown) =>
    logger.error(`afterCommit callback failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    const result = callback();
    if (result instanceof Promise) result.catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * Runs a callback after the transaction of the current async context commits, or at once when no transaction is open.
 *
 * Why: decision 037 rings the real-time doorbell after the commit (a reader must find the row), and many callers hold only
 * `tx`, not `afterCommit` (`NotificationService.enqueue({ tx })` has 21 call sites); the async context finds their
 * transaction without a signature change. A savepoint shares its transaction's list, so a rolled-back savepoint still rings
 * (the reader then finds nothing and sends nothing). Nested `runInTransaction` calls keep their own lists. A callback of a
 * transaction that rolled back never runs; one registered after the commit (a late promise) runs at once.
 *
 * Side effects: whatever the callback does. Inside a transaction runInTransaction awaits it after the commit; outside one it is
 * called at once and not awaited. A failure is logged.
 *
 * @param callback the work to run after the commit (a publish, never a database write that must be atomic with the change)
 */
export function onCommit(callback: () => void | Promise<void>): void {
  const scope = scopes.getStore();
  if (!scope || scope.state === 'committed') {
    runCommitted(callback);
    return;
  }
  if (scope.state === 'open') scope.callbacks.push(callback);
  // A rolled-back transaction: the change never happened, so the callback is dropped.
}

/**
 * Runs `fn` in one database transaction and then its post-commit callbacks.
 *
 * Why: decision 020 and 024 want every state change, its ledger posting and its outbox row in one commit; callers that
 * also touch the cache register the invalidation with `afterCommit` (or `onCommit`) so it happens only for a committed change.
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
  const scope: CommitScope = { callbacks: [], state: 'open' };
  let result: T;
  try {
    result = await scopes.run(scope, () =>
      db.transaction(
        (tx) =>
          fn({
            tx,
            afterCommit: (callback) => {
              if (scope.state !== 'open') throw new Error('afterCommit() was called after the transaction ended');
              scope.callbacks.push(callback);
            },
          }),
        options.isolation || options.readOnly
          ? {
              ...(options.isolation ? { isolationLevel: options.isolation } : {}),
              ...(options.readOnly ? { accessMode: 'read only' as const } : {}),
            }
          : undefined,
      ),
    );
  } catch (error) {
    scope.state = 'rolled-back';
    throw error;
  }
  scope.state = 'committed';
  // The commit succeeded: from here on a failing callback cannot undo the change, so it is only logged. The loop runs in the
  // caller's async context: an onCommit() inside a callback belongs to an enclosing transaction, or runs at once.
  for (const callback of scope.callbacks) {
    try {
      await callback();
    } catch (error) {
      logger.error(`afterCommit callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
