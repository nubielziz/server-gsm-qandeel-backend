// Unit test of the registry of the account list's SQL fragments (decision 064): an unregistered fragment is a boot error, never an empty column.
import { describe, expect, it } from 'bun:test';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AccountListSql } from '@src/modules/identity/ports/account-list-sql';

const dialect = new PgDialect();
const text = (fragment: SQL): string => dialect.sqlToQuery(fragment).sql;
const id = sql`c.id`;

describe('AccountListSql', () => {
  it('throws before the orders module registers its figures, and before the money module registers the balance', () => {
    const list = new AccountListSql();
    expect(() => list.orderFigure('ordersCount', id)).toThrow('not registered');
    expect(() => list.walletBalance(id)).toThrow('not registered');
  });

  it('builds the registered fragment for the figure and the column it is given', () => {
    const list = new AccountListSql();
    list.registerOrderFigure(
      (figure, column) => sql`(select ${sql.raw(figure)} from order_figures where account_id = ${column})`,
    );
    list.registerWalletBalance((column) => sql`(select balance from wallet_balances where account_id = ${column})`);
    expect(text(list.orderFigure('lastOrderAt', id))).toBe(
      '(select lastOrderAt from order_figures where account_id = c.id)',
    );
    expect(text(list.orderFigure('totalSpent', sql`x.id`))).toBe(
      '(select totalSpent from order_figures where account_id = x.id)',
    );
    expect(text(list.walletBalance(id))).toBe('(select balance from wallet_balances where account_id = c.id)');
  });

  it('keeps the two registrations apart: registering one does not satisfy the other', () => {
    const list = new AccountListSql();
    list.registerWalletBalance((column) => sql`${column}`);
    expect(() => list.orderFigure('ordersCount', id)).toThrow('order figures');
    const other = new AccountListSql();
    other.registerOrderFigure((_figure, column) => sql`${column}`);
    expect(() => other.walletBalance(id)).toThrow('wallet balance');
  });

  it('refuses a second registration of either fragment', () => {
    const list = new AccountListSql();
    list.registerOrderFigure((_figure, column) => sql`${column}`);
    list.registerWalletBalance((column) => sql`${column}`);
    expect(() => list.registerOrderFigure((_figure, column) => sql`${column}`)).toThrow('already registered');
    expect(() => list.registerWalletBalance((column) => sql`${column}`)).toThrow('already registered');
  });
});
