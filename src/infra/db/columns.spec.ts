// Unit tests of the column helpers that are more than a type alias (decision 027).
import { describe, expect, it } from 'bun:test';
import { PgDialect, getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { check } from 'drizzle-orm/pg-core';
import { inList, lower } from './columns';

const dialect = new PgDialect({ casing: 'snake_case' });
const table = pgTable('t', { name: text() });

describe('inList', () => {
  it('writes the values into the CHECK expression', () => {
    const { sql } = dialect.sqlToQuery(inList(table.name, ['a', 'b_c']));
    expect(sql).toBe(`"t"."name" in ('a', 'b_c')`);
  });

  it('refuses a value with a quote, which would end up in DDL', () => {
    expect(() => inList(table.name, ["it's"])).toThrow('must not contain a quote');
  });

  it('is accepted by a table definition', () => {
    const withCheck = pgTable('u', { kind: text() }, (t) => [check('u_kind_check', inList(t.kind, ['x']))]);
    expect(getTableConfig(withCheck).checks).toHaveLength(1);
  });
});

describe('lower', () => {
  it('lower-cases a column for case-insensitive indexes', () => {
    expect(dialect.sqlToQuery(lower(table.name)).sql).toBe('lower("t"."name")');
  });
});
