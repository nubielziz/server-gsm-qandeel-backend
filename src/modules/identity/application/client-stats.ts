// ClientStatsDirectory: where the 30-day order figures of a merchant row come from. The orders module registers its source
// when it is built (feature 5); until then every merchant reads as "no orders", which is true.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/** The rolling 30-day figures of one merchant (`Client.stats`, all money in USD, MISMATCHES B26). */
export interface ClientStats {
  /** Orders created in the window. */
  readonly orders: number;
  /** The sum of `total_price` of non-rejected orders, 4 decimals. */
  readonly spend: string;
  /** The sum of `total_price - total_cost` of completed orders, 4 decimals. */
  readonly profit: string;
  /** `profit / spend * 100` with one decimal, or `null` when spend is zero. */
  readonly margin: string | null;
  /** `completed / (completed + rejected) * 100` as a number, or `null` when none finished. */
  readonly successRate: number | null;
  /** The latest order's creation time (ISO), or `null`. */
  readonly lastOrderAt: string | null;
}

/** What the orders module implements. */
export interface ClientStatsSource {
  /**
   * Reads the figures of several merchants for the 30 days before `now`.
   *
   * @param db the database or a transaction
   * @param clientIds the merchants
   * @param now the current time (the injected clock)
   * @returns the figures by merchant id; a merchant without orders may be absent
   */
  statsOf(db: DbExecutor, clientIds: readonly number[], now: Date): Promise<Map<number, ClientStats>>;
}

/** A merchant with no orders. */
export const NO_ORDERS: ClientStats = {
  orders: 0,
  spend: '0.0000',
  profit: '0.0000',
  margin: null,
  successRate: null,
  lastOrderAt: null,
};

/**
 * Gives the merchant rows their order figures.
 *
 * Why: `GET /admin/clients` carries `stats` for staff who hold `wallet:read`. The identity module may not read the orders table,
 * so the orders module registers a {@link ClientStatsSource} (`register`) when it exists.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ClientStatsDirectory {
  private source: ClientStatsSource | undefined;

  /**
   * Registers the source of the figures.
   *
   * @param source the orders module's implementation
   * @throws {Error} when a source is already registered (a boot-time programming error)
   */
  register(source: ClientStatsSource): void {
    if (this.source) throw new Error('A client stats source is already registered.');
    this.source = source;
  }

  /**
   * Reads the figures of several merchants.
   *
   * @param db the database or a transaction
   * @param clientIds the merchants
   * @param now the current time
   * @returns the figures of every merchant in `clientIds` (merchants without orders read as zeros)
   */
  async of(db: DbExecutor, clientIds: readonly number[], now: Date): Promise<Map<number, ClientStats>> {
    const found = this.source ? await this.source.statsOf(db, clientIds, now) : new Map<number, ClientStats>();
    return new Map(clientIds.map((id) => [id, found.get(id) ?? NO_ORDERS]));
  }
}
