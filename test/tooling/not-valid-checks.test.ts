// The four current checks of the append-only vocabularies (decision 064): a row written from now on may say
// `account` and the words that are still current, never `client` or `customer`, yet the rows written before keep their old words, so
// each check is added NOT VALID. A NOT VALID constraint is enforced for every new row and skipped for the old ones; it survives a
// dump and a restore. drizzle-kit writes the constraint validated, so the expand migration is assembled with NOT VALID appended, and
// this test reads the migration text for it and the database for `convalidated = false`; a later migration that validated one of
// them would make the old rows fail the check at once. The text cases run on synthetic SQL that fails first. The database cases
// need the test database.
import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { PgDialect, PgTable as PgTableClass, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as barrel from '@src/infra/db/schema';
import { closeTestDb, testDb } from '../support/db';
import { migrationSql } from '../support/migration-files';

afterAll(closeTestDb);

/** The words of the money ledger's reference types that are current: the list of today without client and customer, with account. */
const currentRefTypes = (): string[] => [
  ...new Set([...barrel.LEDGER_REF_TYPES.filter((word) => word !== 'client' && word !== 'customer'), 'account']),
];

/** The four checks: the constraint, its table and the words a new row may still carry. */
const CURRENT_CHECKS: Array<{ name: string; table: string; words: () => string[] }> = [
  { name: 'audit_logs_actor_type_current_check', table: 'audit_logs', words: () => ['staff', 'account', 'system'] },
  {
    name: 'order_events_actor_type_current_check',
    table: 'order_events',
    words: () => ['staff', 'account', 'supplier', 'system'],
  },
  {
    name: 'ledger_transactions_created_by_type_current_check',
    table: 'ledger_transactions',
    words: () => ['staff', 'account', 'system'],
  },
  { name: 'ledger_transactions_ref_type_current_check', table: 'ledger_transactions', words: currentRefTypes },
];

/** The suffix of the expand migration: the file is numbered at the rebase, so tests find it by name. */
const EXPAND = '_accounts_expand.sql';

/** The statement of a migration that adds a constraint (from "ALTER TABLE" to its semicolon), or undefined. */
function addStatement(sql: string, name: string): string | undefined {
  const start = sql.search(new RegExp(`ADD CONSTRAINT "${name}"`));
  if (start === -1) return undefined;
  const from = sql.lastIndexOf('ALTER TABLE', start);
  const end = sql.indexOf(';', start);
  return sql.slice(from === -1 ? start : from, end === -1 ? sql.length : end + 1);
}

/** The words a statement lists inside quotes after its CHECK, sorted. */
const wordsOf = (statement: string): string[] =>
  [...statement.slice(statement.indexOf('CHECK')).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();

/**
 * What is wrong with the way a migration text adds the current checks.
 * @param sql the text of the migration
 * @param checks the constraints, with the words each lists
 * @returns one line per problem (empty when each check is added, lists exactly its words, and ends in NOT VALID)
 */
function problemsOf(sql: string, checks: Array<{ name: string; words: string[] }>): string[] {
  const problems: string[] = [];
  for (const check of checks) {
    const statement = addStatement(sql, check.name);
    if (statement === undefined) problems.push(`${check.name}: not added`);
    else {
      if (!/\bNOT VALID\s*;?\s*$/.test(statement)) problems.push(`${check.name}: added without NOT VALID`);
      if (JSON.stringify(wordsOf(statement)) !== JSON.stringify([...check.words].sort())) {
        problems.push(
          `${check.name}: lists [${wordsOf(statement).join(', ')}], expected [${[...check.words].sort().join(', ')}]`,
        );
      }
    }
    if (new RegExp(`VALIDATE CONSTRAINT "${check.name}"`).test(sql)) problems.push(`${check.name}: validated`);
  }
  return problems;
}

describe('the text of a migration, on synthetic SQL', () => {
  const good =
    'ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_type_current_check" CHECK ("audit_logs"."actor_type" in (\'staff\', \'account\', \'system\')) NOT VALID;';
  const expectations = [{ name: 'audit_logs_actor_type_current_check', words: ['staff', 'account', 'system'] }];

  it('accepts a check added NOT VALID with the words of today', () => {
    expect(problemsOf(good, expectations)).toEqual([]);
    expect(problemsOf(`${good}\n--> statement-breakpoint\nSELECT 1;`, expectations)).toEqual([]);
  });

  it('fails a check added without NOT VALID, with another list, or not at all', () => {
    expect(problemsOf(good.replace(' NOT VALID', ''), expectations)).toEqual([
      'audit_logs_actor_type_current_check: added without NOT VALID',
    ]);
    expect(problemsOf(good.replace("'staff', ", "'staff', 'client', "), expectations)[0]).toContain(
      'lists [account, client, staff, system]',
    );
    expect(problemsOf('SELECT 1;', expectations)).toEqual(['audit_logs_actor_type_current_check: not added']);
  });

  it('fails a check that is validated afterwards, in the same file or in a later one', () => {
    const validated = `${good}\nALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_actor_type_current_check";`;
    expect(problemsOf(validated, expectations)).toEqual(['audit_logs_actor_type_current_check: validated']);
  });
});

describe('the migrations', () => {
  const sql = (): string => migrationSql(EXPAND);

  it('add the four current checks NOT VALID, with the words of today, in the expand migration', () => {
    expect(
      problemsOf(
        sql(),
        CURRENT_CHECKS.map((check) => ({ name: check.name, words: check.words() })),
      ),
    ).toEqual([]);
  });

  it('never validate one of them, in any migration file', () => {
    const folder = join(import.meta.dir, '../../drizzle');
    const validating = readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) =>
        CURRENT_CHECKS.some((check) =>
          new RegExp(`VALIDATE CONSTRAINT "${check.name}"`).test(readFileSync(join(folder, name), 'utf8')),
        ),
      );
    expect(validating).toEqual([]);
  });
});

describe('the Drizzle schema', () => {
  const dialect = new PgDialect({ casing: 'snake_case' });
  const tables = (): PgTable[] =>
    (Object.values(barrel) as unknown[]).filter((value): value is PgTable => is(value, PgTableClass));

  it('declares the four current checks with the words of today (the migration adds NOT VALID; drizzle-kit cannot say it)', () => {
    for (const check of CURRENT_CHECKS) {
      const table = tables().find((candidate) => getTableConfig(candidate).name === check.table)!;
      const declared = getTableConfig(table).checks.find((candidate) => candidate.name === check.name);
      expect(declared, check.name).toBeDefined();
      const rendered = dialect.sqlToQuery(declared!.value).sql;
      const list = `in (${check
        .words()
        .map((word) => `'${word}'`)
        .join(', ')})`;
      expect(rendered.includes(list), `${check.name}: ${rendered}`).toBe(true);
    }
  });
});

describe('the database', () => {
  it('keeps the four current checks NOT VALID (convalidated = false)', async () => {
    const { pool } = await testDb();
    const { rows } = await pool.query<{ conname: string; convalidated: boolean }>(
      'select conname, convalidated from pg_constraint where conname = any($1::text[]) order by conname',
      [CURRENT_CHECKS.map((check) => check.name)],
    );
    expect(rows.map((row) => row.conname)).toEqual(CURRENT_CHECKS.map((check) => check.name).sort());
    for (const row of rows) expect(row.convalidated, row.conname).toBe(false);
  });

  it('refuses a new audit row by a client or a customer and accepts one by an account, leaving the old rows as they are', async () => {
    const { pool } = await testDb();
    const client = await pool.connect();
    try {
      for (const actor of ['client', 'customer']) {
        await client.query('begin');
        const error = await client
          .query(
            "insert into audit_logs (actor_type, action, entity_type, entity_id) values ($1, 'not valid test', 'test', 1)",
            [actor],
          )
          .then(
            () => undefined,
            (caught: unknown) => caught as { code?: string; constraint?: string },
          );
        await client.query('rollback');
        expect(error?.code, actor).toBe('23514');
        expect(error?.constraint, actor).toBe('audit_logs_actor_type_current_check');
      }
      await client.query('begin');
      await client.query(
        "insert into audit_logs (actor_type, action, entity_type, entity_id) values ('account', 'not valid test', 'test', 1)",
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
