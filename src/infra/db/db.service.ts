// The process-wide Postgres client for Nest (decision 005): one pool, the typed Drizzle instance, the transaction helper.
// The pool connects lazily; it is closed in onApplicationShutdown, after workers have drained in onModuleDestroy.
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../../config';
import { type Database, createDrizzle, createPool } from './database';
import { type TransactionContext, type TransactionOptions, runInTransaction } from './transaction';
import { databaseUrlFor } from './url';

/**
 * Owns the pg pool and the Drizzle instance of this process.
 *
 * Why: decision 005 wants one `Pool` per process with its size from the environment; every repository and the health
 * indicator share it. Under `NODE_ENV=test` it points at the test database (decision 014).
 *
 * Side effects: none until the first query; `onApplicationShutdown` ends the pool.
 */
@Injectable()
export class DbService implements OnApplicationShutdown {
  /** The raw pool, for the health check and for code that needs a dedicated connection (advisory locks, LISTEN). */
  readonly pool: Pool;
  /** The typed Drizzle database. Prefer {@link DbService.runInTransaction} for anything that writes. */
  readonly db: Database;
  private closed = false;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = createPool(databaseUrlFor(config), config.database.poolMax);
    this.db = createDrizzle(this.pool);
  }

  /**
   * Runs `fn` in one transaction and then the callbacks it registered with `afterCommit`.
   *
   * Why: see {@link runInTransaction}; this is the entry point use cases call (decisions 020, 022, 024).
   *
   * @param fn the work, given `tx` and `afterCommit`
   * @param options isolation level
   * @returns what `fn` returned
   * @throws whatever `fn` threw; the transaction is rolled back and no callback runs
   */
  runInTransaction<T>(fn: (context: TransactionContext) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return runInTransaction(this.db, fn, options);
  }

  /**
   * Checks that Postgres answers.
   *
   * Why: the `postgres` health indicator (critical) and readiness checks use it.
   *
   * @throws {Error} when no connection can be made or the query fails
   */
  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  /** Ends the pool; idempotent, so a second shutdown signal or `app.close()` does not throw. */
  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
