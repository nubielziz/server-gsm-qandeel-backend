// The registry of the two SQL fragments the staff list of accounts needs from other modules (decision 064): the order figures and the wallet
// balance. Complete here: the orders module and the money module register their fragments at boot.
import { Injectable } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';

/** A figure of the account list that comes from orders. */
export type OrderFigure = 'ordersCount' | 'lastOrderAt' | 'totalSpent';

/**
 * Builds the SQL of an order figure for one account.
 *
 * @param figure which figure
 * @param accountIdColumn the column that holds the account id in the list query
 * @returns a scalar SQL expression (a correlated subquery or an aggregate join column)
 */
export type OrderFigureSql = (figure: OrderFigure, accountIdColumn: SQL) => SQL;

/**
 * Builds the SQL of the wallet balance of one account.
 *
 * @param accountIdColumn the column that holds the account id in the list query
 * @returns a scalar SQL expression of the balance of the account's live wallet
 */
export type WalletBalanceSql = (accountIdColumn: SQL) => SQL;

/**
 * The SQL fragments the account list takes from the orders and money modules.
 *
 * Why: the list filters and sorts by figures that belong to other modules' tables (orders count, last order, total spent, wallet
 * balance), and identity may not read those tables (decision 016). The owner of each table registers one fragment; the list calls
 * `orderFigure` and `walletBalance`. An unregistered fragment is a boot error, never an empty column.
 *
 * Side effects: none; the fragments are SQL values the list composes into its query.
 *
 * @see GET /admin/clients
 */
@Injectable()
export class AccountListSql {
  private orderFigureSql: OrderFigureSql | undefined;
  private walletBalanceSql: WalletBalanceSql | undefined;

  /**
   * Registers the order figures.
   *
   * @param fn the fragment builder
   * @throws {Error} when one is already registered (a boot-time programming error)
   */
  registerOrderFigure(fn: OrderFigureSql): void {
    if (this.orderFigureSql) throw new Error('The order figures of the account list are already registered');
    this.orderFigureSql = fn;
  }

  /**
   * Registers the wallet balance.
   *
   * @param fn the fragment builder
   * @throws {Error} when one is already registered (a boot-time programming error)
   */
  registerWalletBalance(fn: WalletBalanceSql): void {
    if (this.walletBalanceSql) throw new Error('The wallet balance of the account list is already registered');
    this.walletBalanceSql = fn;
  }

  /**
   * Returns the SQL of an order figure.
   *
   * @param figure which figure
   * @param accountIdColumn the column that holds the account id
   * @returns the registered fragment's SQL
   * @throws {Error} when the orders module has not registered its fragment (a boot error)
   */
  orderFigure(figure: OrderFigure, accountIdColumn: SQL): SQL {
    if (!this.orderFigureSql) throw new Error('The order figures of the account list are not registered');
    return this.orderFigureSql(figure, accountIdColumn);
  }

  /**
   * Returns the SQL of the wallet balance.
   *
   * @param accountIdColumn the column that holds the account id
   * @returns the registered fragment's SQL
   * @throws {Error} when the money module has not registered its fragment (a boot error)
   */
  walletBalance(accountIdColumn: SQL): SQL {
    if (!this.walletBalanceSql) throw new Error('The wallet balance of the account list is not registered');
    return this.walletBalanceSql(accountIdColumn);
  }
}
