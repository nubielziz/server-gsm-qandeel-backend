// ClientStatsDirectory: where the 30-day order figures of an account row come from. The orders module registers its source
// when it is built; until then every account reads as "no orders", which is true.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';

/** The rolling 30-day figures of one account, over every order of the account whatever the door (`AccountView.stats`, all money in USD, MISMATCHES B26). */
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
   * Reads the figures of several accounts for the 30 days before `now`.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts
   * @param now the current time (the injected clock)
   * @returns the figures by account id; an account without orders may be absent
   */
  statsOf(db: DbExecutor, accountIds: readonly number[], now: Date): Promise<Map<number, ClientStats>>;
}

/** An account with no orders. */
export const NO_ORDERS: ClientStats = {
  orders: 0,
  spend: '0.0000',
  profit: '0.0000',
  margin: null,
  successRate: null,
  lastOrderAt: null,
};

/**
 * Gives the account rows their order figures.
 *
 * Why: `GET /admin/clients` carries `stats` for staff who hold `wallet:read`. The identity module may not read the orders table, so the
 * orders module registers a {@link ClientStatsSource} (`register`) when it exists. The count and the date of the last order of every
 * row, and the sorts by them, come from `AccountListSql` instead (a SQL fragment the list embeds).
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
    if (this.source) throw new Error('An account stats source is already registered.');
    this.source = source;
  }

  /**
   * Reads the figures of several accounts.
   *
   * @param db the database or a transaction
   * @param accountIds the accounts
   * @param now the current time
   * @returns the figures of every account in `accountIds` (accounts without orders read as zeros)
   */
  async of(db: DbExecutor, accountIds: readonly number[], now: Date): Promise<Map<number, ClientStats>> {
    const found = this.source ? await this.source.statsOf(db, accountIds, now) : new Map<number, ClientStats>();
    return new Map(accountIds.map((id) => [id, found.get(id) ?? NO_ORDERS]));
  }
}
