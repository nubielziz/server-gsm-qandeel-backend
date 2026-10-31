// Test database support (decision 014): the pool on gsm_test, migrated lazily by the first test that needs it, and
// resetDb(). Nothing here runs from the global preload, so `bun test ./src` (unit tests) works without Docker.
import { createDrizzle, createPool, type Database } from '../../src/infra/db';
import { migrateDatabase } from '../../src/infra/db/migrate';
import { parseEnv } from '../../src/config';
import type { Pool } from 'pg';

/** Connection string of the test database (`DATABASE_URL_TEST`, default `gsm_test` of compose.yaml). */
export const TEST_DATABASE_URL = parseEnv({ ...process.env, NODE_ENV: 'test' }).database.testUrl;

/** A pool and Drizzle instance on the test database. */
export interface TestDb {
  readonly pool: Pool;
  readonly db: Database;
}

/**
 * Refuses to run destructive helpers against anything but a database whose name ends in `_test`.
 *
 * Why: `resetDb()` truncates every table; pointing `DATABASE_URL_TEST` at the development database by mistake must fail.
 *
 * @param url the connection string about to be used
 * @throws {Error} when the database name does not end in `_test`
 */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/_test$/.test(name)) throw new Error(`Refusing to touch database "${name}": test databases end in "_test".`);
}

let migrated: Promise<void> | undefined;

/**
 * Applies the migrations to the test database once per process.
 *
 * Why: the first database test of a run brings `gsm_test` up to date; later calls reuse the same promise. A failure
 * (Docker not running) is remembered, so every database test reports the same clear error instead of hanging.
 *
 * @returns resolves when the test database is up to date
 */
export function migrateTestDb(): Promise<void> {
  assertTestDatabase(TEST_DATABASE_URL);
  migrated ??= migrateDatabase(TEST_DATABASE_URL);
  return migrated;
}

let shared: TestDb | undefined;

/**
 * Opens (once) the shared pool on the migrated test database.
 *
 * Why: tests of a file share one pool; call {@link closeTestDb} in `afterAll` so the process can exit.
 *
 * @returns the pool and the Drizzle instance
 */
export async function testDb(): Promise<TestDb> {
  await migrateTestDb();
  if (!shared) {
    const pool = createPool(TEST_DATABASE_URL, 5);
    shared = { pool, db: createDrizzle(pool) };
  }
  return shared;
}

/** Ends the shared pool; the next {@link testDb} call opens a fresh one. */
export async function closeTestDb(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.pool.end();
}

/**
 * Empties every table of the `public` schema and restarts the id sequences; the migrations table (schema `drizzle`)
 * is left alone.
 *
 * Why: decision 014: each integration test starts from an empty database (`beforeEach(resetDb)`). TRUNCATE does not
 * fire the append-only triggers, which is what lets the ledger tables be emptied.
 */
export async function resetDb(): Promise<void> {
  const { pool } = await testDb();
  const { rows } = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  if (rows.length === 0) return;
  const list = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** The fields of a Postgres error that tests assert on. */
export interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

/**
 * Runs a promise that is expected to fail and returns the underlying Postgres error.
 *
 * Why: Drizzle wraps driver errors (the pg error is the `cause`); tests assert on SQLSTATE and constraint names.
 *
 * @param work the pending query or transaction
 * @returns code, constraint and message of the pg error
 * @throws {Error} when the promise resolves
 */
export async function pgErrorOf(work: PromiseLike<unknown>): Promise<PgErrorInfo> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
      const candidate = current as Error & { code?: string; constraint?: string };
      if (typeof candidate.code === 'string') {
        return { code: candidate.code, constraint: candidate.constraint, message: candidate.message };
      }
      current = (current as Error & { cause?: unknown }).cause;
    }
    return { message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('Expected the database to refuse the statement, but it succeeded.');
}
