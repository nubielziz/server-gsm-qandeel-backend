// Postgres client building blocks (decisions 005, 027, 055): the pg pool with its session time limits, the typed Drizzle instance and
// the types every repository uses. Nothing here connects: a pool opens its first connection when the first query runs.
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

/** Every table of the schema, keyed by its TypeScript name; the type argument of the Drizzle instance. */
export type Schema = typeof schema;

/**
 * Builds the Drizzle instance for a pool: the full schema and snake_case column names (decision 027).
 *
 * Why: the API, the worker, the scripts and the tests must build the client the same way, or column names would drift.
 *
 * @param pool the pg pool queries run on
 * @returns the typed Drizzle database (it also exposes the pool as `$client`)
 */
export function createDrizzle(pool: Pool) {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

/** The typed Drizzle database that {@link createDrizzle} returns. */
export type Database = ReturnType<typeof createDrizzle>;

/** A Drizzle transaction handle, as `Database.transaction` passes it to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can run queries: the database itself or a transaction.
 *
 * Why: decision 024 passes `tx` into services such as `postTransaction(tx, input)`; reads that do not need a
 * transaction accept the same type so one function serves both.
 */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, Schema>;

const poolLogger = new Logger('Postgres');

/**
 * The session time limits of a pool's connections, in milliseconds; 0 means no limit.
 *
 * Why: decision 055: a statement, a lock wait or an idle transaction that runs on for ever holds a connection and the locks it took.
 */
export interface SessionTimeouts {
  /** `statement_timeout`: the longest a statement may run. */
  readonly statementMs: number;
  /** `lock_timeout`: the longest a statement waits for a lock. */
  readonly lockMs: number;
  /** `idle_in_transaction_session_timeout`: a transaction idle longer than this is ended by Postgres. */
  readonly idleInTransactionMs: number;
}

/**
 * Creates a pg pool that does not connect until it is used.
 *
 * Why: decision 005: one pool per process, sized by `DATABASE_POOL_MAX`. Constructors must never connect (the OpenAPI
 * generator builds the app offline). The `error` listeners are required: Postgres restarting emits `error` on idle
 * clients, and an unhandled `error` event would crash the process; a client that is checked out has no listener of the pool's,
 * so every client gets its own when it connects (decision 055: Postgres ending a session, by a time limit or a restart, while a
 * transaction holds it must not end the process; the transaction's next statement fails instead). The limits are session defaults on
 * every connection of this pool (decision 055), sent as startup parameters; a pool without them (migrations, setup) has none.
 *
 * @param url the Postgres connection string
 * @param max the largest number of connections
 * @param timeouts the session limits of every connection; omitted or 0 means none
 * @returns the pool; end it with `pool.end()` on shutdown
 */
export function createPool(url: string, max: number, timeouts?: SessionTimeouts): Pool {
  const pool = new Pool({
    connectionString: url,
    max,
    // Fail a request instead of waiting forever when Postgres is unreachable or the pool is exhausted.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // pg sends a limit only when it is set: `undefined` keeps the server's default (none).
    statement_timeout: timeouts?.statementMs || undefined,
    lock_timeout: timeouts?.lockMs || undefined,
    idle_in_transaction_session_timeout: timeouts?.idleInTransactionMs || undefined,
  });
  pool.on('error', (error) => {
    poolLogger.warn(`Idle Postgres client failed: ${error.message}`);
  });
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      poolLogger.warn(`Postgres client failed: ${error.message}`);
    });
  });
  return pool;
}
