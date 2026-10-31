// Postgres client building blocks (decisions 005, 027): the pg pool, the typed Drizzle instance and the types every
// repository uses. Nothing here connects: a pool opens its first connection when the first query runs.
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
 * Creates a pg pool that does not connect until it is used.
 *
 * Why: decision 005: one pool per process, sized by `DATABASE_POOL_MAX`. Constructors must never connect (the OpenAPI
 * generator builds the app offline). The `error` listener is required: Postgres restarting emits `error` on idle
 * clients, and an unhandled `error` event would crash the process.
 *
 * @param url the Postgres connection string
 * @param max the largest number of connections
 * @returns the pool; end it with `pool.end()` on shutdown
 */
export function createPool(url: string, max: number): Pool {
  const pool = new Pool({
    connectionString: url,
    max,
    // Fail a request instead of waiting forever when Postgres is unreachable or the pool is exhausted.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (error) => {
    poolLogger.warn(`Idle Postgres client failed: ${error.message}`);
  });
  return pool;
}
