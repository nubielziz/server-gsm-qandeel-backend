// Integration tests of the database session time limits (decision 055) on the test database, with pools of their own (no app): the
// limits reach every connection, a statement or a lock wait is cut at its limit, an idle transaction is ended, a transaction raises its
// own statement limit (never lowering it), and a session Postgres ends while a transaction holds it does not end the process. The waits
// are Postgres's own (pg_sleep, a held row lock), well under a second each.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { normalizeException } from '@src/common/errors/normalize-exception';
import { parseEnv } from '@src/config';
import { DbService, createDrizzle, createPool, pgErrorInfo, runInTransaction, schema as s } from '@src/infra/db';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../../support/db';
import { rejectionOf } from '../../support/rejection';

// Every test starts from an empty database (decision 014), and the file leaves none of its rows behind.
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

const NO_LIMITS = { statementMs: 0, lockMs: 0, idleInTransactionMs: 0 };

/** Runs `work` with a pool of its own and ends the pool afterwards. */
async function withPool<T>(pool: Pool, work: (pool: Pool) => Promise<T>): Promise<T> {
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

/** The value Postgres shows for a setting on one connection of the pool. */
async function shown(pool: Pool, name: 'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout') {
  const { rows } = await pool.query<{ value: string }>(`select current_setting('${name}') as value`);
  return rows[0]?.value;
}

describe('database session time limits (decision 055)', () => {
  it('gives every connection of the pool the configured limits', async () => {
    await testDb();
    const limited = new DbService(
      parseEnv({
        NODE_ENV: 'test',
        DATABASE_URL_TEST: TEST_DATABASE_URL,
        DATABASE_STATEMENT_TIMEOUT_MS: '1500',
        DATABASE_LOCK_TIMEOUT_MS: '1200',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '2500',
      }),
    );
    const plain = new DbService(parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL }));
    try {
      expect(await shown(limited.pool, 'statement_timeout')).toBe('1500ms');
      expect(await shown(limited.pool, 'lock_timeout')).toBe('1200ms');
      expect(await shown(limited.pool, 'idle_in_transaction_session_timeout')).toBe('2500ms');
      // Under NODE_ENV=test the defaults are no limits at all.
      expect(await shown(plain.pool, 'statement_timeout')).toBe('0');
      expect(await shown(plain.pool, 'lock_timeout')).toBe('0');
      expect(await shown(plain.pool, 'idle_in_transaction_session_timeout')).toBe('0');
    } finally {
      await limited.onApplicationShutdown();
      await plain.onApplicationShutdown();
    }
  });

  it('cancels a statement that runs longer than the limit', async () => {
    await withPool(createPool(TEST_DATABASE_URL, 1, { ...NO_LIMITS, statementMs: 100 }), async (pool) => {
      const error = await rejectionOf(pool.query('select pg_sleep(1)'));
      expect(pgErrorInfo(error)?.code).toBe('57014');
      expect(normalizeException(error, { exposeInternals: false }).error.status).toBe(503);
    });
  });

  it('ends a lock wait at the limit', async () => {
    const { db } = await testDb();
    const [role] = await db.insert(s.roles).values({ name: 'Locked for the test' }).returning({ id: s.roles.id });
    const holder = createPool(TEST_DATABASE_URL, 1);
    const waiter = createPool(TEST_DATABASE_URL, 1, { ...NO_LIMITS, lockMs: 100 });
    const held = await holder.connect();
    try {
      await held.query('begin');
      await held.query('select id from roles where id = $1 for update', [role!.id]);
      const error = await rejectionOf(waiter.query('select id from roles where id = $1 for update', [role!.id]));
      expect(pgErrorInfo(error)?.code).toBe('55P03');
    } finally {
      await held.query('rollback');
      held.release();
      await holder.end();
      await waiter.end();
      await db.delete(s.roles).where(eq(s.roles.id, role!.id));
    }
  });

  it('lets one transaction raise its statement limit', async () => {
    await withPool(createPool(TEST_DATABASE_URL, 1, { ...NO_LIMITS, statementMs: 100 }), async (pool) => {
      const db = createDrizzle(pool);
      const raised = await runInTransaction(
        db,
        async ({ tx }) => {
          await tx.execute(sql`select pg_sleep(0.3)`);
          return (await tx.execute<{ value: string }>(sql`select current_setting('statement_timeout') as value`))
            .rows[0]?.value;
        },
        { statementTimeoutMs: 2_000 },
      );
      expect(raised).toBe('2s');
      const error = await rejectionOf(
        runInTransaction(db, async ({ tx }) => {
          await tx.execute(sql`select pg_sleep(0.3)`);
        }),
      );
      expect(pgErrorInfo(error)?.code).toBe('57014');
      // The raise was for that transaction only.
      expect(await shown(pool, 'statement_timeout')).toBe('100ms');
    });
  });

  it('never lowers the session limit: none, or a larger one, is kept', async () => {
    const inside = (pool: Pool, statementTimeoutMs: number) =>
      runInTransaction(
        createDrizzle(pool),
        async ({ tx }) =>
          (await tx.execute<{ value: string }>(sql`select current_setting('statement_timeout') as value`)).rows[0]
            ?.value,
        { statementTimeoutMs },
      );
    await withPool(createPool(TEST_DATABASE_URL, 1), async (pool) => {
      expect(await inside(pool, 120_000)).toBe('0');
    });
    await withPool(createPool(TEST_DATABASE_URL, 1, { ...NO_LIMITS, statementMs: 300_000 }), async (pool) => {
      expect(await inside(pool, 120_000)).toBe('5min');
      // 0 asks for no limit, which is never lower.
      expect(await inside(pool, 0)).toBe('0');
    });
  });

  it('ends a transaction left idle longer than the limit, and the process goes on', async () => {
    const other = createPool(TEST_DATABASE_URL, 1);
    await withPool(createPool(TEST_DATABASE_URL, 1, { ...NO_LIMITS, idleInTransactionMs: 200 }), async (pool) => {
      const error = await rejectionOf(
        runInTransaction(createDrizzle(pool), async ({ tx }) => {
          await tx.execute(sql`select 1`);
          // The transaction idles while another session waits (Postgres's own wait, longer than the limit).
          await other.query('select pg_sleep(0.6)');
          await new Promise<void>((resolve) => setImmediate(resolve));
          await tx.execute(sql`select 1`);
        }),
      );
      expect(normalizeException(error, { exposeInternals: false }).error.code).toBe('UNAVAILABLE');
      expect((await pool.query<{ one: number }>('select 1 as one')).rows[0]?.one).toBe(1);
    });
    await other.end();
  });

  it('a session Postgres ends while a transaction holds it does not end the process', async () => {
    const other = createPool(TEST_DATABASE_URL, 1);
    await withPool(createPool(TEST_DATABASE_URL, 2), async (pool) => {
      const error = await rejectionOf(
        runInTransaction(createDrizzle(pool), async ({ tx }) => {
          const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
          // Waits until the backend is gone (up to 5 s), so its FATAL message reaches this client while no statement runs.
          await other.query('select pg_terminate_backend($1, 5000)', [pid]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          await tx.execute(sql`select 1`);
        }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(normalizeException(error, { exposeInternals: false }).error.code).toBe('UNAVAILABLE');
      // The test process is alive and the pool hands out a working connection again.
      expect((await pool.query<{ one: number }>('select 1 as one')).rows[0]?.one).toBe(1);
    });
    await other.end();
  });
});
