// Keeps the list of places that refer to a stored file (`unreferenced()`, src/modules/platform/infra/file.repository.ts) in step with the
// schema (decision 053): the janitor and the attachment deletes use it, so a column that names a file and is missing from it would let a
// file in use be deleted. Reads the schema the way schema-structure.test.ts does, without a database.
import { describe, expect, it } from 'bun:test';
import { is } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as barrel from '@src/infra/db/schema';
import { unreferenced } from '@src/modules/platform/infra/file.repository';

const casing = new CasingCache('snake_case');
const dialect = new PgDialect({ casing: 'snake_case' });
const tablesOf = (exports: Record<string, unknown>): PgTable[] =>
  Object.values(exports).filter((value): value is PgTable => is(value, PgTable));
const tables = tablesOf(barrel);
const nameOf = (table: PgTable) => getTableConfig(table).name;

/**
 * The integer array columns that hold file ids (the database cannot enforce them with a foreign key). Listed here by hand: a new one
 * must be added to this list AND to `unreferenced()`, in the same change. A test below fails when an array column whose name mentions a
 * file is missing from this list, so a forgotten one is found here first.
 */
const FILE_ID_ARRAY_COLUMNS = ['ticket_messages.file_ids', 'kyc_submissions.file_ids', 'disputes.evidence_file_ids'];

/** Every foreign key to `files.id`, as `table.column`: read from the schema, nothing to maintain. */
function foreignKeysToFiles(): string[] {
  const found: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const target = getTableConfig(reference.foreignTable);
      if (target.name !== 'files') continue;
      for (const column of reference.columns) found.push(`${config.name}.${casing.getColumnCasing(column)}`);
    }
  }
  return found.sort();
}

/**
 * The `table.column` pairs a rendered `unreferenced()` condition compares with the file's id: each `not exists (select 1 from <table> where ...)`
 * clause names its table and the columns equal to (`=`) or containing (`@>`) the id.
 */
function coveredColumns(condition: string): Set<string> {
  const covered = new Set<string>();
  for (const clause of condition.split('not exists (select 1 from ').slice(1)) {
    const table = /^(\w+)/.exec(clause)?.[1];
    if (!table) continue;
    for (const match of clause.matchAll(/\b(\w+)\s*(?:=|@>)\s*(?:array\[)?\w+\.id\b/g))
      covered.add(`${table}.${match[1]}`);
  }
  return covered;
}

const rendered = () => dialect.sqlToQuery(unreferenced('f')).sql;

describe('the places that refer to a stored file', () => {
  it('finds the foreign keys to files in the schema', () => {
    // A sanity bound that proves the reader finds them: orders (2), invoices, payments, data requests, listings (2) and payment gateways.
    expect(foreignKeysToFiles().length).toBeGreaterThanOrEqual(8);
  });

  it('are all covered by unreferenced(): every foreign key to files.id', () => {
    const covered = coveredColumns(rendered());
    const missing = foreignKeysToFiles().filter((column) => !covered.has(column));
    expect(missing, `not covered by unreferenced(): ${missing.join(', ')}`).toEqual([]);
  });

  it('are all covered by unreferenced(): every array column that holds file ids', () => {
    const covered = coveredColumns(rendered());
    const missing = FILE_ID_ARRAY_COLUMNS.filter((column) => !covered.has(column));
    expect(missing, `not covered by unreferenced(): ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the list of array columns true to the schema: each exists, and no array column that names a file is left out', () => {
    const arrayColumns = new Set<string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (column.getSQLType().endsWith('[]')) arrayColumns.add(`${config.name}.${casing.getColumnCasing(column)}`);
      }
    }
    const gone = FILE_ID_ARRAY_COLUMNS.filter((column) => !arrayColumns.has(column));
    expect(gone, `listed but not an array column of the schema: ${gone.join(', ')}`).toEqual([]);
    const unlisted = [...arrayColumns].filter(
      (column) => /file/i.test(column.split('.')[1]!) && !FILE_ID_ARRAY_COLUMNS.includes(column),
    );
    expect(
      unlisted,
      `an array column that names a file must be listed here and in unreferenced(): ${unlisted.join(', ')}`,
    ).toEqual([]);
  });

  it('is judged on the real condition: a clause that leaves a column out is reported by name', () => {
    const complete = rendered();
    // Dropping the second column of the orders clause must show up as exactly that column.
    const broken = complete.replace(' or result_file_id = f.id', '');
    expect(broken).not.toBe(complete);
    const covered = coveredColumns(broken);
    expect(covered.has('orders.input_file_id')).toBe(true);
    expect(covered.has('orders.result_file_id')).toBe(false);
    expect(coveredColumns(complete).has('orders.result_file_id')).toBe(true);
    // An array clause is read too.
    expect(coveredColumns(complete).has('disputes.evidence_file_ids')).toBe(true);
    expect(
      coveredColumns(complete.replace('evidence_file_ids @> array[f.id]', 'x')).has('disputes.evidence_file_ids'),
    ).toBe(false);
  });

  it('every table it names is a table of the schema', () => {
    const names = new Set(tables.map(nameOf));
    for (const column of coveredColumns(rendered())) expect(names.has(column.split('.')[0]!), column).toBe(true);
  });
});
