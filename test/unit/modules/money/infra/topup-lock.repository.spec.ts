// Unit test of the account top-up lock: one advisory lock per account, keyed `topup:<accountId>` (decision 064).
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbExecutor } from '@src/infra/db';
import { lockAccountTopUps } from '@src/modules/money/infra/topup-lock.repository';

const dialect = new PgDialect();

/** A transaction that records the statements it is asked to run. */
function recordingTx(): { tx: DbExecutor; statements: { sql: string; params: unknown[] }[] } {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: (statement: SQL) => {
      const { sql, params } = dialect.sqlToQuery(statement);
      statements.push({ sql, params });
      return Promise.resolve([]);
    },
  } as unknown as DbExecutor;
  return { tx, statements };
}

describe('lockAccountTopUps', () => {
  it('takes one transaction-scoped advisory lock keyed by the account id', async () => {
    const { tx, statements } = recordingTx();
    await lockAccountTopUps(tx, 41);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(statements[0]?.params).toEqual(['topup:41']);
  });

  it('gives two accounts two different keys and one account always the same key', async () => {
    const { tx, statements } = recordingTx();
    await lockAccountTopUps(tx, 5);
    await lockAccountTopUps(tx, 6);
    await lockAccountTopUps(tx, 5);
    expect(statements.map((statement) => statement.params[0])).toEqual(['topup:5', 'topup:6', 'topup:5']);
  });
});
