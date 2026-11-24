// Unit tests of the SQL fragments of the order read model that decision 064 changed: the channel from the door, the scopes of the merchant's
// and the shop's own orders and the order figures of the account list. The fragments are rendered to text and read: no database.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { channelSql, merchantDoorSql, orderFigureSql, shopDoorSql } from '@src/modules/orders/infra/order-sql';

// The application's client uses snake_case names (src/infra/db/database.ts), so the fragments are rendered the same way.
const dialect = new PgDialect({ casing: 'snake_case' });
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(fragment);
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('channelSql', () => {
  it('is b2c for the store door and b2b for every other door, and reads no buyer column', () => {
    const { sql: text, params } = render(channelSql);
    expect(flat(text)).toBe(`(case when "orders"."source" = 'store' then 'b2c' else 'b2b' end)`);
    expect(params).toEqual([]);
    expect(text).not.toContain('client_id');
    expect(text).not.toContain('customer_id');
  });
});

describe('the scopes of an account', () => {
  it("the merchant's orders are the account's own orders of the doors that hold from the wallet", () => {
    const { sql: text, params } = render(merchantDoorSql(8));
    expect(flat(text)).toBe('("orders"."account_id" = $1 and not "orders"."source" = \'store\')');
    expect(params).toEqual([8]);
  });

  it("the shop's orders are the account's own orders of the store door", () => {
    const { sql: text, params } = render(shopDoorSql(8));
    expect(flat(text)).toBe('("orders"."account_id" = $1 and "orders"."source" = \'store\')');
    expect(params).toEqual([8]);
  });

  it('read the buyer from account_id, never from client_id or customer_id', () => {
    for (const scope of [merchantDoorSql(1), shopDoorSql(1)]) {
      const { sql: text } = render(scope);
      expect(text).not.toContain('client_id');
      expect(text).not.toContain('customer_id');
    }
  });
});

describe('orderFigureSql', () => {
  const account = sql`"clients"."id"`;

  it('counts every order of the account, both doors and any status', () => {
    const { sql: text } = render(orderFigureSql('ordersCount', account));
    expect(flat(text)).toBe('(select count(*)::int from orders o where o.account_id = "clients"."id")');
  });

  it('takes the date of the latest order of the account', () => {
    const { sql: text } = render(orderFigureSql('lastOrderAt', account));
    expect(flat(text)).toBe('(select max(o.created_at) from orders o where o.account_id = "clients"."id")');
  });

  it('adds up what the account paid, tax included, and leaves out the rejected orders', () => {
    const { sql: text } = render(orderFigureSql('totalSpent', account));
    expect(flat(text)).toBe(
      '(select coalesce(sum(o.total_price + o.tax_amount) filter (where o.status <> \'rejected\'), 0)::numeric(18,4) from orders o where o.account_id = "clients"."id")',
    );
  });

  it('is one correlated subquery on the account column it is given, and filters by no door', () => {
    for (const figure of ['ordersCount', 'lastOrderAt', 'totalSpent'] as const) {
      const { sql: text } = render(orderFigureSql(figure, sql`c.id`));
      expect(text).toContain('o.account_id = c.id');
      expect(text).not.toContain('source');
    }
  });
});
