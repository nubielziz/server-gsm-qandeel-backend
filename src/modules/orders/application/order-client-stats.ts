// OrderClientStats: the orders source of identity's ClientStatsDirectory, so `GET /admin/clients` shows each merchant's 30-day
// spend, orders and success rate (feature 5 replaces identity's "no orders" stand-in).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DbExecutor } from '../../../infra/db';
import { ClientStatsDirectory, type ClientStats, type ClientStatsSource } from '../../identity';
import { clientStatsRows } from '../infra/order-stats.repository';

/** The rolling window of the merchant figures. */
export const STATS_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Computes the 30-day figures of merchants from their orders.
 *
 * Why: ANSWERS merchants (GET /admin/clients, B26): `orders` counts the orders created in the last 30 days, `spend` sums the price
 * of the ones not rejected, `profit` sums `total_price - total_cost` of the completed ones, `margin` is `profit / spend` in percent
 * with one decimal (`null` without spend), `successRate` is completed over completed plus rejected in percent (`null` while none
 * finished) and `lastOrderAt` the newest order's creation time. The window starts 30 days before the injected clock's now and has no end.
 *
 * Side effects: registers itself as the source of `ClientStatsDirectory` when the module starts; reads `orders` (one grouped query
 * per page, never cached).
 */
@Injectable()
export class OrderClientStats implements ClientStatsSource, OnModuleInit {
  constructor(private readonly directory: ClientStatsDirectory) {}

  /** Registers this class as the figures' source. */
  onModuleInit(): void {
    this.directory.register(this);
  }

  /**
   * Reads the figures of several merchants.
   *
   * @param db the database or a transaction
   * @param clientIds the merchants of a page
   * @param now the current time (the injected clock)
   * @returns the figures of every merchant that has orders in the window
   */
  async statsOf(db: DbExecutor, clientIds: readonly number[], now: Date): Promise<Map<number, ClientStats>> {
    const from = new Date(now.getTime() - STATS_WINDOW_DAYS * DAY_MS);
    const rows = await clientStatsRows(db, clientIds, from);
    return new Map(
      rows.map((row): [number, ClientStats] => {
        const spend = new Decimal(row.spend);
        const finished = row.completed + row.rejected;
        return [
          row.clientId,
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
}
