// ListedPrices: the price-protection memory of user rule 9 (MISMATCHES B117 (4)): the last price listed to a merchant for a
// service. The portal catalog and price export (this feature) and the Dhru and REST v1 lists (7a) record what they show; the
// order paths (feature 5, Dhru, REST v1) read it for the PRICE_CHANGED guard.
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { listedPrices } from '../db/schema';

/** A price a merchant was shown. */
export interface ListedPrice {
  readonly serviceId: number;
  readonly price: Money;
  readonly currency: string;
  /** When this price was first listed to the merchant (the time the price last changed). */
  readonly listedAt: Date;
}

/** One price to record. */
export interface ListedPriceEntry {
  readonly serviceId: number;
  readonly price: Money;
}

/** Rows written per statement. */
const CHUNK = 500;

/**
 * Remembers and reads the prices merchants were last shown.
 *
 * Why: a merchant who saw a price on a list and orders later must not be charged much more without a refresh. The memory keeps
 * the last listed price per merchant and service; it is written only when the price changes, so its time says since when the
 * merchant has seen this price. `record` is for every list a merchant reads (portal, Dhru, REST v1); `find` and `findMany` are
 * for the order paths, which compare the charge with it through `checkPriceChange`.
 *
 * Side effects: `record` writes `listed_prices` (no audit: it is the merchant's own read, not a staff change).
 *
 * @see docs/contract/MISMATCHES.md (B117)
 */
@Injectable()
export class ListedPrices {
  /**
   * Records the prices a merchant was just shown.
   *
   * @param db the database or a transaction
   * @param clientId the merchant
   * @param entries the services and the prices shown; a service listed twice keeps the last price
   * @param at the time of the listing (the clock's now)
   * @param currency the currency of the prices (USD)
   * @returns how many rows were inserted or changed (an unchanged price writes nothing)
   */
  async record(
    db: DbExecutor,
    clientId: number,
    entries: readonly ListedPriceEntry[],
    at: Date,
    currency = 'USD',
  ): Promise<number> {
    // One price per service, written in id order: two lists recorded at once take the row locks in the same order.
    const byService = new Map(entries.map((entry) => [entry.serviceId, entry.price]));
    const rows = [...byService.entries()]
      .sort(([a], [b]) => a - b)
      .map(([serviceId, price]) => ({ clientId, serviceId, price: price.toWire(), currency, listedAt: at }));
    let written = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const result = await db
        .insert(listedPrices)
        .values(rows.slice(start, start + CHUNK))
        .onConflictDoUpdate({
          target: [listedPrices.clientId, listedPrices.serviceId],
          set: {
            price: sql`excluded.price`,
            currency: sql`excluded.currency`,
            listedAt: sql`excluded.listed_at`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${listedPrices.price} is distinct from excluded.price or ${listedPrices.currency} is distinct from excluded.currency`,
        })
        .returning({ id: listedPrices.id });
      written += result.length;
    }
    return written;
  }

  /**
   * Reads the price a merchant was last shown for one service.
   *
   * @param db the database or a transaction
   * @param clientId the merchant
   * @param serviceId the service
   * @returns the listed price, or `undefined` when none is on record (the guard then has nothing to compare)
   */
  async find(db: DbExecutor, clientId: number, serviceId: number): Promise<ListedPrice | undefined> {
    const [row] = await db
      .select()
      .from(listedPrices)
      .where(and(eq(listedPrices.clientId, clientId), eq(listedPrices.serviceId, serviceId)))
      .limit(1);
    return row
      ? { serviceId: row.serviceId, price: Money.of(row.price), currency: row.currency, listedAt: row.listedAt }
      : undefined;
  }

  /**
   * Reads the prices a merchant was last shown for several services.
   *
   * @param db the database or a transaction
   * @param clientId the merchant
   * @param serviceIds the services
   * @returns the listed prices by service id; services never listed are absent
   */
  async findMany(db: DbExecutor, clientId: number, serviceIds: readonly number[]): Promise<Map<number, ListedPrice>> {
    if (serviceIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(listedPrices)
      .where(and(eq(listedPrices.clientId, clientId), inArray(listedPrices.serviceId, [...new Set(serviceIds)])));
    return new Map(
      rows.map((row) => [
        row.serviceId,
        { serviceId: row.serviceId, price: Money.of(row.price), currency: row.currency, listedAt: row.listedAt },
      ]),
    );
  }
}
