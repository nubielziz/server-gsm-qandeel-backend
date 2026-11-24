// Unit test of the door helpers: an order is prepaid exactly when it came through the shop checkout (decision 064).
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ORDER_SOURCES } from '@src/modules/orders/db/schema';
import { isPrepaidOrder, prepaidOrderSql } from '@src/modules/orders/domain/door';

const dialect = new PgDialect();

describe('isPrepaidOrder', () => {
  it('is true for the store door only, whatever the other fields of the order are', () => {
    for (const source of ORDER_SOURCES) expect(isPrepaidOrder({ source })).toBe(source === 'store');
  });

  it('ignores any buyer column: the door decides, not who the buyer is today', () => {
    expect(isPrepaidOrder({ source: 'store', clientId: 7 } as { source: 'store' })).toBe(true);
    expect(isPrepaidOrder({ source: 'portal', clientId: null } as { source: 'portal' })).toBe(false);
  });
});

describe('prepaidOrderSql', () => {
  it('compares the given source column with the store door', () => {
    const query = dialect.sqlToQuery(prepaidOrderSql(sql`o.source`));
    expect(query.sql).toBe("o.source = 'store'");
    expect(query.params).toEqual([]);
  });

  it('can be negated to scope the merchant views to the doors that hold from the wallet', () => {
    const query = dialect.sqlToQuery(sql`not (${prepaidOrderSql(sql`orders.source`)})`);
    expect(query.sql).toBe("not (orders.source = 'store')");
  });
});
