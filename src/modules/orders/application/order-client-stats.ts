// OrderClientStats: the orders source of identity's ClientStatsDirectory, so `GET /admin/clients` shows each account's 30-day spend, orders and
// success rate, and the owner of the `orderFigure` entry of `AccountListSql` (the count, the date and the total of orders the account list
// sorts by). Every figure covers every order of the account, whatever the door (decision 064).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DbExecutor } from '../../../infra/db';
import { AccountListSql, ClientStatsDirectory, type ClientStats, type ClientStatsSource } from '../../identity';
import { orderFigureSql } from '../infra/order-sql';
import { accountStatsRows, lifetimeStatsRows } from '../infra/order-stats.repository';

/** The rolling window of the account figures. */
export const STATS_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** The lifetime figures of one account over every order it placed. */
export interface LifetimeOrderStats {
  /** How many orders the account ever placed, any status and door. */
  readonly ordersCount: number;
  /** When the first one was placed (ISO). */
  readonly firstOrderAt: string;
  /** When the latest one was placed (ISO). */
  readonly lastOrderAt: string;
  /** What the account paid in all: `total_price + tax_amount` of the orders that were not rejected, 4 decimals (USD). */
  readonly totalSpent: string;
}

/**
 * Computes the figures of accounts from their orders.
 *
 * Why: ANSWERS merchants (GET /admin/clients, B26) and decision 064: `orders` counts the orders created in the last 30 days, `spend` sums the
 * price of the ones not rejected, `profit` sums `total_price - total_cost` of the completed ones, `margin` is `profit / spend` in percent with one
 * decimal (`null` without spend), `successRate` is completed over completed plus rejected in percent (`null` while none finished) and
 * `lastOrderAt` the newest order's creation time. The window starts 30 days before the injected clock's now and has no end. The lifetime figures
 * (`ordersCount`, `firstOrderAt`, `lastOrderAt`, `totalSpent`) run over every order of the account; the same four figures, as SQL, reach the account
 * list through `AccountListSql` for its sorts.
 *
 * Side effects: registers itself as the source of `ClientStatsDirectory` and registers `orderFigureSql` with `AccountListSql` when the module
 * starts (a second registration of either is a boot error); reads `orders` (one grouped query per page, never cached).
 *
 * @see GET /admin/clients
 */
@Injectable()
export class OrderClientStats implements ClientStatsSource, OnModuleInit {
  constructor(
    private readonly directory: ClientStatsDirectory,
    private readonly listSql: AccountListSql,
  ) {}

  /** Registers this class as the figures' source and the order figures of the account list. */
  onModuleInit(): void {
    this.directory.register(this);
    this.listSql.registerOrderFigure(orderFigureSql);
  }

  /**
   * Reads the 30-day figures of several accounts.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts of a page
   * @param now the current time (the injected clock)
   * @returns the figures of every account that has orders in the window
   */
  async statsOf(db: DbExecutor, accountIds: readonly number[], now: Date): Promise<Map<number, ClientStats>> {
    const from = new Date(now.getTime() - STATS_WINDOW_DAYS * DAY_MS);
    const rows = await accountStatsRows(db, accountIds, from);
    return new Map(
      rows.map((row): [number, ClientStats] => {
        const spend = new Decimal(row.spend);
        const finished = row.completed + row.rejected;
        return [
          row.accountId,
          {
            orders: row.orders,
            spend: row.spend,
            profit: row.profit,
            margin: spend.isZero() ? null : new Decimal(row.profit).div(spend).mul(100).toFixed(1),
            successRate: finished === 0 ? null : (row.completed / finished) * 100,
            lastOrderAt: row.lastOrderAt === null ? null : row.lastOrderAt.toISOString(),
          },
        ];
      }),
    );
  }

  /**
   * Reads the lifetime figures of several accounts.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts
   * @returns the figures of every account that placed at least one order (an account without orders is absent)
   */
  async lifetimeOf(db: DbExecutor, accountIds: readonly number[]): Promise<Map<number, LifetimeOrderStats>> {
    const rows = await lifetimeStatsRows(db, accountIds);
    return new Map(
      rows.map((row): [number, LifetimeOrderStats] => [
        row.accountId,
        {
          ordersCount: row.ordersCount,
          firstOrderAt: row.firstOrderAt.toISOString(),
          lastOrderAt: row.lastOrderAt.toISOString(),
          totalSpent: row.totalSpent,
        },
      ]),
    );
  }
}
