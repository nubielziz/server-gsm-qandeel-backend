// DbService.runInTransaction against real Postgres (decisions 022, 024): commit and rollback, post-commit callbacks,
// the isolation level, a failing commit, and the pool lifecycle.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { parseEnv } from '../../src/config';
import { DbService, schema as s } from '../../src/infra/db';
import { insertLedgerAccounts } from '../support/fixtures';
import { TEST_DATABASE_URL, closeTestDb, pgErrorOf, resetDb, testDb } from '../support/db';
import { rejectionOf } from '../support/rejection';

beforeEach(resetDb);
afterAll(closeTestDb);

/** A DbService on the test database, built the way Nest builds it. */
async function service(): Promise<DbService> {
  await testDb();
  return new DbService(parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL }));
}

describe('DbService.runInTransaction', () => {
  it('commits the work and returns its result', async () => {
    const db = await service();
    try {
      const id = await db.runInTransaction(async ({ tx }) => {
        const [row] = await tx.insert(s.roles).values({ name: 'Owner' }).returning({ id: s.roles.id });
        return row!.id;
      });
      expect(id).toBe(1);
      expect(await db.db.$count(s.roles)).toBe(1);
    } finally {
      await db.onApplicationShutdown();
    }
  });

  it('rolls everything back when the work throws', async () => {
    const db = await service();
    try {
      const error = await rejectionOf(
        db.runInTransaction(async ({ tx }) => {
          await tx.insert(s.roles).values({ name: 'Owner' });
          throw new Error('stop');
        }),
      );
      expect(String(error)).toContain('stop');
      expect(await db.db.$count(s.roles)).toBe(0);
    } finally {
      await db.onApplicationShutdown();
    }
  });

  it('runs afterCommit callbacks after the commit: the committed row is visible to another connection', async () => {
    const db = await service();
    const { db: other } = await testDb();
    const seen: number[] = [];
    try {
      await db.runInTransaction(async ({ tx, afterCommit }) => {
        await tx.insert(s.roles).values({ name: 'Owner' });
        afterCommit(async () => {
          seen.push(await other.$count(s.roles));
        });
        // Not yet committed: a second connection sees nothing.
        expect(await other.$count(s.roles)).toBe(0);
      });
      expect(seen).toEqual([1]);
    } finally {
      await db.onApplicationShutdown();
    }
  });

  it('does not run afterCommit callbacks after a rollback', async () => {
    const db = await service();
    let ran = false;
    try {
      const error = await rejectionOf(
        db.runInTransaction(({ afterCommit }) => {
          afterCommit(() => {
            ran = true;
          });
          return Promise.reject(new Error('rolled back'));
        }),
      );
      expect(String(error)).toContain('rolled back');
      expect(ran).toBe(false);
    } finally {
      await db.onApplicationShutdown();
    }
  });

  it('does not run afterCommit callbacks when the COMMIT fails (an unbalanced ledger transaction)', async () => {
    const db = await service();
    const { db: setup } = await testDb();
    const { bank } = await insertLedgerAccounts(setup);
    let ran = false;
    try {
      const failure = await pgErrorOf(
        db.runInTransaction(async ({ tx, afterCommit }) => {
          const [header] = await tx
            .insert(s.ledgerTransactions)
            .values({ kind: 'deposit', refType: 'system', idempotencyKey: 'unbalanced', createdByType: 'system' })
            .returning({ id: s.ledgerTransactions.id });
          await tx
            .insert(s.ledgerEntries)
            .values({ transactionId: header!.id, accountId: bank, amount: '5', balanceAfter: '5' });
          afterCommit(() => {
            ran = true;
          });
        }),
      );
      expect(failure.constraint).toBe('ledger_entries_zero_sum');
      expect(ran).toBe(false);
      expect(await db.db.$count(s.ledgerTransactions)).toBe(0);
    } finally {
      await db.onApplicationShutdown();
    }
  });

  it('applies the requested isolation level, read committed by default', async () => {
    const db = await service();
    const level = async (isolation?: 'serializable' | 'repeatable read') =>
      db.runInTransaction(
        async ({ tx }) => (await tx.execute(sql`show transaction_isolation`)).rows[0]!.transaction_isolation,
        isolation ? { isolation } : undefined,
      );
    try {
      expect(await level()).toBe('read committed');
      expect(await level('repeatable read')).toBe('repeatable read');
      expect(await level('serializable')).toBe('serializable');
    } finally {
      await db.onApplicationShutdown();
    }
  });
});

describe('DbService lifecycle', () => {
  it('does not connect until the first query, answers ping, and can be shut down twice', async () => {
    await testDb();
    const unreachable = new DbService(
      parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres://gsm:gsm@127.0.0.1:1/x' }),
    );
    // Construction succeeded without a database: that is what lets the OpenAPI generator build the app offline.
    expect(await rejectionOf(unreachable.ping())).toBeInstanceOf(Error);
    await unreachable.onApplicationShutdown();
    await unreachable.onApplicationShutdown();

    const db = await service();
    expect(await db.ping()).toBeUndefined();
    await db.onApplicationShutdown();
  });
});
