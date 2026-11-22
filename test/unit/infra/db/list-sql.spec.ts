// Unit tests of listWhere's search term (decision 047): a search with no field left to search matches no row.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { listWhere } from '@src/infra/db/list-sql';

const dialect = new PgDialect();
const columns = { name: sql`c.name`, email: sql`c.email` };

describe('listWhere search', () => {
  it('matches the listed fields, case-insensitively and escaped', () => {
    const where = listWhere({ filters: [], search: { text: '50%_x', fields: ['name', 'email'] } }, columns);
    const query = dialect.sqlToQuery(where!);
    expect(query.sql).toBe('(c.name ilike $1 or c.email ilike $2)');
    expect(query.params).toEqual(['%50\\%\\_x%', '%50\\%\\_x%']);
  });

  it('matches no row when no field is left to search (a caller who may not search addresses)', () => {
    const where = listWhere({ filters: [], search: { text: 'jane', fields: [] } }, columns);
    expect(dialect.sqlToQuery(where!)).toEqual({ sql: 'false', params: [] });
    const withFilter = listWhere(
      { filters: [{ field: 'name', op: 'eq', values: ['a'] }], search: { text: 'jane', fields: [] } },
      columns,
    );
    expect(dialect.sqlToQuery(withFilter!).sql).toBe('c.name = $1 and false');
  });

  it('has no condition without a search or a filter', () => {
    expect(listWhere({ filters: [], search: undefined }, columns)).toBeUndefined();
  });
});
